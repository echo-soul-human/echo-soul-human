const srv = Deno.serve({ port: 8795, onListen() {} }, async (req) => new Response('', { status: 201 }));
await new Promise((r) => setTimeout(r, 150));
const verdict = await (await import('../supabase/functions/_shared/ssrf.ts')).assertSafeBaseUrl('http://127.0.0.1:8795/push/abc');
console.log('ssrf verdict:', JSON.stringify(verdict.ok ? { ok: true } : verdict));
try {
  const res = await fetch('http://127.0.0.1:8795/push/abc', { method: 'POST', body: new Uint8Array([1, 2, 3]), redirect: 'error' });
  console.log('plain fetch status:', res.status);
} catch (e) { console.log('plain fetch threw:', (e as Error).name, (e as Error).message.slice(0, 120)); }
await srv.shutdown();
