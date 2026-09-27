/**
 * _shared/md5.ts — 纯 JS MD5
 *
 * 为什么手写：爱发电 API 的 sign = md5(token + kv拼接)，而
 * Web Crypto（Deno / Edge Runtime）**不提供 MD5**，只提供 SHA 家族。
 * 引第三方包要么依赖 esm.sh 运行时可用性，要么体积更大 —— 这个算法 60 行搞定，
 * 且是**签名计算**这种关键路径，宁可自带可控实现。
 *
 * ⚠️ 仅用于与爱发电的签名兼容，不得用于任何安全用途（密码哈希、完整性校验等）。
 */

/** 每轮左移位数 */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** 常量表 K[i] = floor(abs(sin(i+1)) * 2^32) */
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/** UTF-8 编码（与 Node Buffer 的 utf8 行为对齐，含孤立代理项的处理） */
function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);

    if (c < 0x80) { out.push(c); continue; }
    if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); continue; }

    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        // 合法代理对 ⇒ 4 字节
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (next & 0x3ff);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
        i++;
        continue;
      }
      // 高位孤立代理 ⇒ U+FFFD（与 Node/WHATWG 一致）
      out.push(0xef, 0xbf, 0xbd);
      continue;
    }

    if (c >= 0xdc00 && c <= 0xdfff) {
      // 低位孤立代理 ⇒ U+FFFD
      out.push(0xef, 0xbf, 0xbd);
      continue;
    }

    out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

export function md5(input: string | Uint8Array): string {
  const msg = typeof input === 'string' ? utf8Bytes(input) : input;
  const bitLen = msg.length * 8;

  // 填充：0x80 + 若干 0 + 64 位小端长度，总长 ≡ 56 (mod 64)
  const withPad = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
  withPad.set(msg);
  withPad[msg.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < withPad.length; off += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }

      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }

    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  const words = [a0, b0, c0, d0];
  let hex = '';
  for (const w of words) {
    for (let i = 0; i < 4; i++) {
      hex += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex;
}
