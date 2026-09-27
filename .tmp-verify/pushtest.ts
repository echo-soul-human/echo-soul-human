const { sendWebPush } = await import('../supabase/functions/push/_testcopy.ts');

// 一个本地"假推送服务"：记录收到的字节并原样回 201
let received: { body: Uint8Array; headers: Headers } | null = null;
const srv = Deno.serve({ port: 8794, onListen() {} }, async (req) => {
  const buf = new Uint8Array(await req.arrayBuffer());
  received = { body: buf, headers: req.headers };
  return new Response('', { status: 201 });
});
await new Promise((r) => setTimeout(r, 150));

// 扮演浏览器：生成订阅密钥对与 auth secret
const sub = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const asRaw = new Uint8Array(await crypto.subtle.exportKey('raw', sub.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ''; for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// VAPID 密钥对（JWK -> raw）
const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', vapid.publicKey) as any;
const vapidPub = b64u(new Uint8Array([0x04, ...new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey))]));
const privJwk = await crypto.subtle.exportKey('jwk', vapid.privateKey) as any;

const payload = JSON.stringify({ title: 'TA 有话想说', body: '今天过得怎么样？', tag: 'care:x', url: '/' });
const outcome = await sendWebPush(
  { publicKey: vapidPub, privateKey: privJwk.d, subject: 'mailto:a@b.co' },
  'http://127.0.0.1:8794/push/abc',
  b64u(asRaw), b64u(authSecret), payload,
);
console.log('outcome =', outcome);

// ── 服务端侧自解：完全按 RFC 8188 从记录体还原明文 ──
const r = received!;
const body = r.body;
const salt = body.subarray(0, 16);
const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
const idlen = body[20];
const uaPublic = body.subarray(21, 21 + idlen);
const cipher = body.subarray(21 + idlen);
console.log('header: rs=' + rs, 'idlen=' + idlen, 'ctLen=' + cipher.length);

const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, sub.privateKey, 256));
const hmacKey = (k: Uint8Array) => crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const hmac = async (k: Uint8Array, d: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'HMAC' }, await hmacKey(k), d));
const enc = new TextEncoder();
const uap = enc.encode('http://127.0.0.1:8794');
const info = concatBytes(enc.encode('WebPush: info\0'), asRaw, uaPublic, enc.encode('aes128gcm'));
const prk = await hmac(ecdh, concatBytes(uap, new Uint8Array([0])));
const ikm = await hmac(prk, concatBytes(info, new Uint8Array([1])));
const contentKey = ikm.subarray(0, 16), nonce = ikm.subarray(16, 27);
const iv = new Uint8Array(12); iv.set(nonce, 1);
const keyObj = await crypto.subtle.importKey('raw', contentKey, { name: 'AES-GCM' }, false, ['decrypt']);
const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, keyObj, cipher));
let pad = 0;
for (; pad < plain.length; pad++) if (plain[pad] === 1) break;
const text = new TextDecoder().decode(plain.subarray(0, pad));
console.log('decrypted =', text);
console.log('MATCH =', text === payload);
console.log('auth header ok =', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(r!.headers.get('authorization') ?? ''));
console.log('ttl =', r!.headers.get('ttl'), 'encoding =', r!.headers.get('content-encoding'), '(must be null)');

// VAPID 签名用公钥验证
const [h, c, s] = (r!.headers.get('authorization')!.slice('vapid t='.length)).split(', ')[0].split('.');
const pubJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
const vk = await crypto.subtle.importKey('jwk', pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const derToJose = () => {}; void derToJose;
// JOSE r||s -> DER
function joseToDer(jose: Uint8Array): Uint8Array {
  const trim = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };
  const encInt = (b: Uint8Array) => { const t = trim(b); const pad0 = t[0] & 0x80 ? 1 : 0; const body = new Uint8Array(t.length + pad0); if (pad0) body[0] = 0; body.set(t, pad0); return concatBytes(new Uint8Array([0x02, body.length]), body); };
  const seq = concatBytes(encInt(jose.subarray(0, 32)), encInt(jose.subarray(32, 64)));
  return concatBytes(new Uint8Array([0x30, seq.length]), seq);
}
const claimsJson = JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/')));
console.log('jwt aud =', claimsJson.aud, 'sub =', claimsJson.sub, 'exp>now =', claimsJson.exp * 1000 > Date.now());
const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk, joseToDer(new Uint8Array((() => { const b64 = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(b64); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; })())), enc.encode(`${h}.${c}`));
console.log('VAPID SIGNATURE VALID =', verified);

await srv.shutdown();
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
