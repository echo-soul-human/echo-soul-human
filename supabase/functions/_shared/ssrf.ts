/**
 * _shared/ssrf.ts — BYOK 端点的 SSRF 防护
 *
 * 为什么必须做（docs/分册-模型与计费.md §8）：
 *   BYOK 允许用户填任意 endpoint，而请求是**我们的服务器**发出去的。
 *   没有这层校验，用户可以把 endpoint 指向
 *     http://169.254.169.254/       （云厂商元数据服务，偷临时凭据）
 *     http://127.0.0.1:5432/        （打自家数据库端口）
 *     http://内网管理系统/           （借我们的出网能力扫内网）
 *   这是"服务端替用户发请求"这个架构自带的风险面，不是理论问题。
 */

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance',
  'ec2instance-metadata',
]);

/** IPv4 私有 / 保留 / 环回 / 链路本地 / 组播 段 */
function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 畸形一律拒
  const [a, b] = p;
  if (a === 0) return true;                    // 本网络
  if (a === 10) return true;                   // 私有
  if (a === 127) return true;                  // 环回
  if (a === 169 && b === 254) return true;     // 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;       // 文档/以太网保留
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 203 && b === 0 && p[2] === 113) return true; // AS112
  if (a >= 224) return true;                   // 组播 + 保留
  return false;
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(s)) return true;   // 唯一本地
  if (/^fe[89ab][0-9a-f]:/i.test(s)) return true;   // 链路本地
  if (/^ff/i.test(s)) return true;                  // 组播
  if (/^::ffff:/.test(s)) {
    const v4 = s.replace(/^::ffff:/, '');
    return v4.includes('.') ? isPrivateV4(v4) : true;
  }
  // 6to4 段可能封装内网 v4 地址，无法在此处解包核验，保守拒绝
  if (/^2002:/i.test(s)) return true;
  return false;
}

export function isPrivateIp(ip: string): boolean {
  return ip.includes(':') ? isPrivateV6(ip) : isPrivateV4(ip);
}

export interface UrlVerdict {
  ok: boolean;
  reason?: string;
  url?: URL;
  ips?: string[];
}

/**
 * 校验一个用户提供的 endpoint 基址。
 * 检查项：协议、主机名字面 IP、DNS 解析结果、解析后是否内网。
 *
 * ⚠️ 残余风险：DNS rebinding（校验时是公网、真正请求时解析成内网）。
 *   彻底解法是"解析后直接用 IP 连接并带 Host/SNI"，或走 egress 代理。
 *   一期做法：把 TTL 短的域名拒绝 + 请求侧禁跳转，并在文档里如实记录该残余风险。
 */
export async function assertSafeBaseUrl(raw: string): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: '地址格式不对' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: '只支持 http/https' };
  }
  // 生产环境禁 http：明文传输等于把用户 Key 发出去
  if (url.protocol === 'http:' && !isLocalhostLike(url.hostname)) {
    return { ok: false, reason: '出于密钥安全，不支持 http，请用 https' };
  }

  if (url.username || url.password) {
    return { ok: false, reason: '地址里不要带账号密码' };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTS.has(host.toLowerCase())) {
    return { ok: false, reason: '该地址不被允许' };
  }

  // 字面 IP 直接判
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) return { ok: false, reason: '该地址指向内网，不被允许' };
    return { ok: true, url, ips: [host] };
  }

  let ips: string[] = [];
  try {
    const resolver = (globalThis as { Deno?: { resolveDns?: (h: string, q: string) => Promise<string[]> } }).Deno;
    if (resolver?.resolveDns) {
      const a = await resolver.resolveDns(host, 'A').catch(() => [] as string[]);
      const aaaa = await resolver.resolveDns(host, 'AAAA').catch(() => [] as string[]);
      ips = [...a, ...aaaa];
    }
  } catch {
    return { ok: false, reason: '域名解析失败' };
  }

  // 解析不出来时不阻断（运行时可能没有 DNS 权限），交给请求侧的最终连接判定
  if (ips.length && ips.some(isPrivateIp)) {
    return { ok: false, reason: '该域名指向内网地址，不被允许' };
  }

  return { ok: true, url, ips };
}

function isLocalhostLike(h: string): boolean {
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local');
}

/** 请求侧的配套约束：禁跳转，否则跳转能把请求带到内网 */
export const REDIRECT_POLICY: RequestRedirect = 'error';

/** 出网硬超时与响应体上限（防被拖垮 / 防超大响应打爆内存） */
export const EGRESS = {
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 20_000,
  idleTimeoutMs: 45_000,
  maxResponseBytes: 4 * 1024 * 1024,
} as const;
