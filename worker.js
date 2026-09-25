const enc = new TextEncoder();

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}

async function sessionValid(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const token = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith('nyg_admin='))?.slice(10);
  if (!token) return false;
  const [expires, signature] = token.split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = await sign(expires, env.ADMIN_SESSION_SECRET);
  if (signature.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < signature.length; i++) difference |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      if (!env.ADMIN_ACCESS_CODE || !env.ADMIN_SESSION_SECRET) return reply({ error: 'Admin login bado haijawekwa kwenye server.' }, 503);
      const body = await request.json().catch(() => ({}));
      if (body.code !== env.ADMIN_ACCESS_CODE) return reply({ error: 'Access code si sahihi.' }, 401);
      const expires = String(Date.now() + 8 * 60 * 60 * 1000);
      const token = `${expires}.${await sign(expires, env.ADMIN_SESSION_SECRET)}`;
      return reply({ ok: true }, 200, { 'set-cookie': `nyg_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` });
    }

    if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
      return reply({ ok: true }, 200, { 'set-cookie': 'nyg_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!await sessionValid(request, env)) return reply({ error: 'Tafadhali ingia kama admin.' }, 401);
      if (url.pathname === '/api/admin/status') return reply({ aiConfigured: Boolean(env.ELEVENLABS_API_KEY) });

      if (url.pathname === '/api/music/history' && request.method === 'GET') {
        const listed = await env.MUSIC_BUCKET.list({ prefix: 'generated/', limit: 50 });
        const items = listed.objects
          .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
          .map(object => ({
            key: object.key,
            id: object.key.replace(/^generated\//, '').replace(/\.mp3$/i, ''),
            created: object.uploaded,
            size: object.size,
            url: `/music/${encodeURIComponent(object.key)}`
          }));
        return reply({ items });
      }

      if (url.pathname === '/api/humming/upload' && request.method === 'POST') {
        const type = (request.headers.get('content-type') || '').split(';')[0].toLowerCase();
        const allowed = new Map([
          ['audio/webm', 'webm'], ['audio/ogg', 'ogg'], ['audio/mp4', 'm4a'],
          ['audio/mpeg', 'mp3'], ['audio/wav', 'wav'], ['audio/x-wav', 'wav']
        ]);
        if (!allowed.has(type)) return reply({ error: 'Tuma audio ya WebM, OGG, M4A, MP3 au WAV.' }, 415);
        const length = Number(request.headers.get('content-length') || 0);
        if (length > 15 * 1024 * 1024) return reply({ error: 'Recording imezidi MB 15.' }, 413);
        const audio = await request.arrayBuffer();
        if (audio.byteLength > 15 * 1024 * 1024) return reply({ error: 'Recording imezidi MB 15.' }, 413);
        const id = crypto.randomUUID();
        const key = `references/${id}.${allowed.get(type)}`;
        await env.MUSIC_BUCKET.put(key, audio, { httpMetadata: { contentType: type } });
        return reply({ id, url: `/music/${encodeURIComponent(key)}` });
      }

      if (url.pathname === '/api/music/generate' && request.method === 'POST') {
        if (!env.ELEVENLABS_API_KEY) return reply({ error: 'AI engine bado haijaunganishwa.' }, 503);
        const b = await request.json().catch(() => ({}));
        const duration = Math.min(180, Math.max(30, Number(b.duration) || 30));
        const bpm = Math.min(180, Math.max(50, Number(b.bpm) || 96));
        const prompt = `${String(b.prompt || '').slice(0,1800)}. ${b.genre} style, ${b.mood} mood, ${b.key}, ${bpm} BPM. Instruments: ${String(b.instruments || 'piano, bass and drums').slice(0,300)}. Instrumental only, no lead vocals.`;
        if (prompt.length < 40) return reply({ error: 'Andika maelezo ya muziki kwanza.' }, 400);

        const ai = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192', {
          method: 'POST', headers: { 'content-type': 'application/json', 'xi-api-key': env.ELEVENLABS_API_KEY },
          body: JSON.stringify({ prompt, music_length_ms: duration * 1000, model_id: 'music_v2' })
        });
        if (!ai.ok) return reply({ error: `AI generation imeshindwa (${ai.status}). Credits hazitakatwa tena bila kukagua.` }, 502);
        const id = crypto.randomUUID();
        const key = `generated/${id}.mp3`;
        await env.MUSIC_BUCKET.put(key, ai.body, { httpMetadata: { contentType: 'audio/mpeg', contentDisposition: `attachment; filename="nyg-ai-${id}.mp3"` } });
        return reply({ id, url: `/music/${key}` });
      }
      return reply({ error: 'API route haijapatikana.' }, 404);
    }
if (url.pathname === "/pay") {
  try {
    const tokenRes = await fetch(
      "https://api.clickpesa.com/third-parties/generate-token",
      {
        method: "POST",
        headers: {
          "client-id": env.CLICKPESA_CLIENT_ID,
          "api-key": env.CLICKPESA_API_KEY
        }
      }
    );

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.token) {
      return new Response(JSON.stringify(tokenData), {
        status: tokenRes.status,
        headers: { "content-type": "application/json" }
      });
    }

    const orderReference = "NYG-" + Date.now();

    const checkoutRes = await fetch(
      "https://api.clickpesa.com/third-parties/checkout-link/generate-checkout-url",
      {
        method: "POST",
        headers: {
          "Authorization": tokenData.token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
  totalPrice: "1000",
          orderCurrency: "TZS",
  orderReference: orderReference,
  customerName: "NYG Music Customer",
  customerEmail: "nygcenter1@gmail.com",
  customerPhone: "255755498731",
  description: "I'm Still Going On - NYG Music",
  callbackUrl: "https://nygmusichub.com/",
  wooCommerceCallbackURL: ""
})
      }
    );

    const checkoutData = await checkoutRes.json();

    if (!checkoutRes.ok || !checkoutData.checkoutLink) {
      return new Response(JSON.stringify(checkoutData), {
        status: checkoutRes.status,
        headers: { "content-type": "application/json" }
      });
    }

    return Response.redirect(checkoutData.checkoutLink, 302);

  } catch (error) {
    return new Response("ClickPesa error: " + error.message, {
      status: 500
    });
  }
}
    if (url.pathname.startsWith('/music/')) {
      if (!await sessionValid(request, env)) return new Response('Unauthorized', { status: 401 });
      const key = decodeURIComponent(url.pathname.slice(7));
      const object = await env.MUSIC_BUCKET.get(key);
      if (!object) return new Response('Audio haijapatikana.', { status: 404 });
      const headers = new Headers(); object.writeHttpMetadata(headers); headers.set('etag', object.httpEtag);
      return new Response(object.body, { headers });
    }

    return env.ASSETS.fetch(request);
  }
};
