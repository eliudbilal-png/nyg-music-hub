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
  return signature === await sign(expires, env.ADMIN_SESSION_SECRET);
}

const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

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

    if (url.pathname.startsWith('/api/')) {
      if (!await sessionValid(request, env)) return reply({ error: 'Tafadhali ingia kama admin.' }, 401);
      if (url.pathname === '/api/admin/status') return reply({ aiConfigured: Boolean(env.ELEVENLABS_API_KEY) });

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
