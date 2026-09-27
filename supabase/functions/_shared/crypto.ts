/**
 * _shared/crypto.ts — BYOK 凭据的信封加密
 *
 * 定案依据（docs/HANDOFF.md §3-C1、docs/分册-模型与计费.md §4.3）：
 *   用户 API Key 只在服务端解密使用，绝不下发浏览器/设备，
 *   不写日志、不进错误信息、不进统计数据。
 *
 * 方案：信封加密
 *   主密钥 MK（env BYOK_MASTER_KEY，32 字节 base64）只存在于 Secrets；
 *   每条 Key 用独立的随机数据密钥 DK 加密（AES-256-GCM）；
 *   DK 本身用 MK 包裹后与密文同存。
 *   ⇒ 单条泄露不牵连全局；MK 轮换时可批量重包而不需要用户重填 Key。
 */

const ENC = 'AES-GCM';
const IV_BYTES = 12; // GCM 标准
const TAG_BITS = 128;

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

function masterKey(): Uint8Array {
  const raw = Deno.env.get('BYOK_MASTER_KEY');
  if (!raw) throw new Error('BYOK_MASTER_KEY not configured');
  const mk = b64decode(raw);
  if (mk.length !== 32) throw new Error('BYOK_MASTER_KEY must be 32 bytes base64');
  return mk;
}

let mkHandlePromise: Promise<CryptoKey> | null = null;
function masterKeyHandle(): Promise<CryptoKey> {
  if (!mkHandlePromise) {
    mkHandlePromise = crypto.subtle.importKey('raw', masterKey() as BufferSource, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
      'wrapKey',
      'unwrapKey',
    ]);
  }
  return mkHandlePromise;
}

export interface SealedSecret {
  /** 用 MK 包裹后的数据密钥 */
  wrappedDk: string;
  /** 加密数据密钥时用的 IV */
  dkIv: string;
  /** 密文 */
  ciphertext: string;
  /** 加密明文时用的 IV */
  iv: string;
}

/** 加密用户 Key。返回的四元组一起存库。 */
export async function seal(plaintext: string): Promise<SealedSecret> {
  const mk = await masterKeyHandle();
  const dk = await crypto.subtle.generateKey({ name: ENC, length: 256 }, true, ['encrypt', 'decrypt']);

  // 用 AES-GCM 而不是 AES-KW 包裹数据密钥：
  // 部分 Deno/Edge 运行时对 AES-KW 的 wrapKey 支持不一致，会静默产出坏数据。
  const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const dkRaw = await crypto.subtle.exportKey('raw', dk);
  const wrappedDkBuf = await crypto.subtle.encrypt(
    { name: ENC, iv: wrapIv, tagLength: TAG_BITS },
    mk,
    dkRaw,
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: ENC, iv, tagLength: TAG_BITS },
    dk,
    new TextEncoder().encode(plaintext),
  );

  return {
    wrappedDk: b64encode(wrappedDkBuf),
    dkIv: b64encode(wrapIv),
    ciphertext: b64encode(ct),
    iv: b64encode(iv),
  };
}

/**
 * 解密。返回值只在当次请求内存活，
 * ★ 调用方不得把它写进日志、错误对象、响应体。
 */
export async function open(sealed: SealedSecret): Promise<string> {
  const mk = await masterKeyHandle();

  const dkRaw = await crypto.subtle.decrypt(
    { name: ENC, iv: b64decode(sealed.dkIv), tagLength: TAG_BITS },
    mk,
    b64decode(sealed.wrappedDk),
  );
  const dk = await crypto.subtle.importKey('raw', dkRaw as BufferSource, { name: ENC }, false, [
    'decrypt',
  ]);

  const plain = await crypto.subtle.decrypt(
    { name: ENC, iv: b64decode(sealed.iv), tagLength: TAG_BITS },
    dk,
    b64decode(sealed.ciphertext),
  );
  return new TextDecoder().decode(plain);
}

/** 给用户看的掩码：只保留后 4 位，够辨认是哪把 Key（03 号专篇 §3.2） */
export function mask(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return `****${tail}`;
}

/** 生成主密钥（部署时跑一次，写进 Supabase Secrets） */
export function generateMasterKey(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}
