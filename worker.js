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
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  const expected = await sign(expires, env.ADMIN_SESSION_SECRET);
  if (signature.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < signature.length; i++) difference |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
async function handleMemberAuth(request, env, url, path, method) {
  const signup = path === '/api/members/signup' && method === 'POST';
  const verify = path === '/api/members/verify' && method === 'GET';

  if (!signup && !verify) return null;

  if (!env.MEMBERS_DB) {
    return reply({ error: 'Database ya wanachama haijaunganishwa.' }, 503);
  }

  if (signup) {
    if (!sameOrigin(request, url)) {
      return reply({ error: 'Ombi halijaruhusiwa.' }, 403);
    }

    if (!env.EMAIL) {
      return reply({ error: 'Huduma ya barua pepe haijaunganishwa.' }, 503);
    }

    const data = await request.json().catch(() => null);
    const fullName = typeof data?.full_name === 'string'
      ? data.full_name.trim()
      : '';
    const email = typeof data?.email === 'string'
      ? data.email.trim()
      : '';
    const password = typeof data?.password === 'string'
      ? data.password
      : '';

    if (fullName.length < 2 || fullName.length > 100) {
      return reply({ error: 'Jina kamili liwe na herufi 2 hadi 100.' }, 400);
    }

    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply({ error: 'Barua pepe si sahihi.' }, 400);
    }

    if (password.length < 8 || password.length > 200) {
      return reply({ error: 'Nenosiri liwe na angalau herufi 8.' }, 400);
    }

    const normalizedEmail = email.toLowerCase();
    const memberId = crypto.randomUUID();
    const memberCode = 'NYG-' +
      crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

    const rawTokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const rawToken = Array.from(
      rawTokenBytes,
      byte => byte.toString(16).padStart(2, '0')
    ).join('');

    const tokenDigest = await crypto.subtle.digest(
      'SHA-256',
      enc.encode(rawToken)
    );
    const tokenHash = Array.from(
      new Uint8Array(tokenDigest),
      byte => byte.toString(16).padStart(2, '0')
    ).join('');

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const passwordBits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      passwordKey,
      256
    );

    const passwordHash = 'pbkdf2-sha256$100000$' +
      Array.from(salt, byte => byte.toString(16).padStart(2, '0')).join('') +
      '$' +
      Array.from(new Uint8Array(passwordBits),
        byte => byte.toString(16).padStart(2, '0')).join('');

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (24 * 60 * 60);

    try {
      await env.MEMBERS_DB.prepare(
        "INSERT INTO members (id, member_code, full_name, email, email_normalized, password_hash, status) VALUES (?, ?, ?, ?, ?, ?, 'pending_email')"
      ).bind(
        memberId,
        memberCode,
        fullName,
        email,
        normalizedEmail,
        passwordHash
      ).run();

      await env.MEMBERS_DB.prepare(
        'INSERT INTO member_email_verification_tokens (token_hash, member_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)'
      ).bind(tokenHash, memberId, expiresAt, now).run();

      const verifyUrl = new URL('/api/members/verify', url.origin);
      verifyUrl.searchParams.set('token', rawToken);

      await env.EMAIL.send({
        to: email,
        from: 'noreply@mail.nygmusichub.com',
        subject: 'Thibitisha barua pepe yako - NYG Music Hub',
        text: 'Thibitisha akaunti yako kwa kufungua kiungo hiki: ' +
          verifyUrl.toString(),
        html: '<p>Karibu NYG Music Hub.</p><p><a href="' +
          verifyUrl.toString() +
          '">Thibitisha barua pepe yako</a></p><p>Kiungo kitaisha baada ya saa 24.</p>'
      });

      return reply({
        message: 'Akaunti imeundwa. Angalia barua pepe yako ili kuthibitisha.'
      }, 201);
    } catch (error) {
      await env.MEMBERS_DB.prepare(
        'DELETE FROM members WHERE id = ?'
      ).bind(memberId).run().catch(() => {});

      if (/unique|constraint/i.test(String(error?.message || ''))) {
        return reply({ error: 'Barua pepe hii tayari imesajiliwa.' }, 409);
      }

      return reply({
        error: 'Usajili haujakamilika. Jaribu tena baadaye.'
      }, 500);
    }
  }

  const rawToken = url.searchParams.get('token') || '';

  if (!/^[a-f0-9]{64}$/i.test(rawToken)) {
    return reply({ error: 'Kiungo cha uthibitisho si sahihi au kimeisha muda.' }, 400);
  }

  const tokenDigest = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(rawToken)
  );
  const tokenHash = Array.from(
    new Uint8Array(tokenDigest),
    byte => byte.toString(16).padStart(2, '0')
  ).join('');
  const now = Math.floor(Date.now() / 1000);

  try {
    const record = await env.MEMBERS_DB.prepare(
      'SELECT member_id, expires_at, used_at FROM member_email_verification_tokens WHERE token_hash = ?'
    ).bind(tokenHash).first();

    if (!record || record.used_at !== null || Number(record.expires_at) <= now) {
      return reply({
        error: 'Kiungo si sahihi, kimetumika, au muda wake umeisha.'
      }, 400);
    }

    const verifiedAt = new Date().toISOString();

    await env.MEMBERS_DB.batch([
      env.MEMBERS_DB.prepare(
        "UPDATE members SET status = 'active', verified_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_email'"
      ).bind(verifiedAt, verifiedAt, record.member_id),

      env.MEMBERS_DB.prepare(
        'UPDATE member_email_verification_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'
      ).bind(now, tokenHash)
    ]);

    return reply({
      message: 'Barua pepe imethibitishwa. Akaunti yako iko tayari.'
    });
  } catch {
    return reply({
      error: 'Uthibitishaji haujakamilika. Jaribu tena baadaye.'
    }, 500);
  }
}
const allowedVideos = new Set([
  'EwOFoJZerDs', '-lkZ63H_pqs', 'aAxYDrwIdsw', '80v3e5pqBiE', '_pbNPbDjArw'
]);

const videos = {
  'EwOFoJZerDs': 'MAOMBI - AZZO DREY',
  '-lkZ63H_pqs': 'SEMA NENO - NYG WORSHIP',
  'aAxYDrwIdsw': 'TEMBEA NA YESU - NYG WORSHIP',
  '80v3e5pqBiE': 'TWENDE - NUEL HENRY',
  '_pbNPbDjArw': 'JIRANI - AFANDE BRIGHT'
};

function validVisitorId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
}

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) return origin === url.origin;
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
        const memberAuthResponse =
      await handleMemberAuth(request, env, url, path, method);
    if (memberAuthResponse) return memberAuthResponse;
// NYG EVENTS - EDIT NA DELETE
if (
  ['/api/events/admin/update', '/api/events/admin/delete'].includes(path) &&
  method === 'POST'
) {
  if (!(await sessionValid(request, env))) {
    return reply({ error: 'Tafadhali ingia kama admin.' }, 401);
  }

  if (!sameOrigin(request, url)) {
    return reply({ error: 'Forbidden origin' }, 403);
  }

  if (!env.EVENTS_DB) {
    return reply({ error: 'Database haijaunganishwa.' }, 503);
  }

  const multipart = (request.headers.get('content-type') || '')
    .startsWith('multipart/form-data');

  let form = null;

  if (multipart) {
    const length = Number(request.headers.get('content-length'));

    if (!length || length > 55 * 1024 * 1024) {
      return reply({ error: 'Ukubwa wa faili haukubaliki.' }, 413);
    }

    form = await request.formData().catch(() => null);
  }

  const data = multipart
    ? (form ? Object.fromEntries(form.entries()) : null)
    : await request.json().catch(() => null);

  const id = Number(data?.event_id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return reply({ error: 'ID si sahihi.' }, 400);
  }

  try {
    const event = await env.EVENTS_DB.prepare(
      'SELECT image_key, video_key FROM events WHERE id = ?'
    ).bind(id).first();

    if (!event) {
      return reply({ error: 'Tukio halijapatikana.' }, 404);
    }

    // HARIRI TUKIO
    if (path.endsWith('/update')) {
      const title = typeof data.title === 'string'
        ? data.title.trim() : '';

      const description = typeof data.description === 'string'
        ? data.description.trim() : '';

      const date = typeof data.event_date === 'string'
        ? data.event_date.trim() : '';

      const link = typeof data.media_url === 'string'
        ? data.media_url.trim() : '';

      if (!title || title.length > 200 ||
          !description || description.length > 10000) {
        return reply({ error: 'Kagua kichwa na maelezo.' }, 400);
      }

      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply({ error: 'Tarehe si sahihi.' }, 400);
      }

      if (link) {
        try {
          if (
            link.length > 2048 ||
            !['http:', 'https:'].includes(new URL(link).protocol)
          ) {
            throw new Error();
          }
        } catch {
          return reply({ error: 'Link si sahihi.' }, 400);
        }
      }

      const files = [];

      for (const [field, allowed, limit] of [
        [
          'image',
          ['image/jpeg', 'image/png', 'image/webp'],
          5 * 1024 * 1024
        ],
        [
          'video',
          ['video/mp4', 'video/webm', 'video/quicktime'],
          50 * 1024 * 1024
        ]
      ]) {
        const file = form?.get(field);

        if (!file) continue;

        if (
          typeof file === 'string' ||
          !allowed.includes(file.type) ||
          !file.size ||
          file.size > limit
        ) {
          return reply({
            error: 'Faili si sahihi au ni kubwa mno.'
          }, 400);
        }

        files.push({
          field,
          file,
          key: `events/${field}/${crypto.randomUUID()}`
        });
      }

      if (files.length && !env.EVENTS_BUCKET) {
        return reply({
          error: 'Hifadhi ya faili haijaunganishwa.'
        }, 503);
      }

      const uploaded = [];

      try {
        for (const item of files) {
          await env.EVENTS_BUCKET.put(
            item.key,
            await item.file.arrayBuffer(),
            {
              httpMetadata: {
                contentType: item.file.type
              }
            }
          );

          uploaded.push(item.key);
        }

        const image = files.find(item => item.field === 'image');
        const video = files.find(item => item.field === 'video');

        const result = await env.EVENTS_DB.prepare(`
          UPDATE events
          SET title = ?, description = ?, event_date = ?,
              media_url = ?, image_key = ?, video_key = ?,
              updated_at = datetime('now')
          WHERE id = ? AND image_key IS ? AND video_key IS ?
        `).bind(
          title,
          description,
          date || null,
          link || null,
          image?.key || event.image_key,
          video?.key || event.video_key,
          id,
          event.image_key,
          event.video_key
        ).run();

        if (result.meta?.changes !== 1) {
          throw new Error('Tukio limebadilika; jaribu tena.');
        }

      } catch (error) {
        await Promise.allSettled(
          uploaded.map(key => env.EVENTS_BUCKET.delete(key))
        );

        throw error;
      }

      const old = files.map(item =>
        item.field === 'image' ? event.image_key : event.video_key
      ).filter(Boolean);

      const removed = await Promise.allSettled(
        old.map(key => env.EVENTS_BUCKET.delete(key))
      );

      return reply({
        success: true,
        cleanup_pending: removed.some(item => item.status === 'rejected')
      });
    }

    // FUTA TUKIO
    if ((event.image_key || event.video_key) && !env.EVENTS_BUCKET) {
      return reply({ error: 'Hifadhi ya faili haijaunganishwa.' }, 503);
    }

    const result = await env.EVENTS_DB.prepare(
      'DELETE FROM events WHERE id = ?'
    ).bind(id).run();

    if (result.meta?.changes !== 1) {
      return reply({ error: 'Tukio halijapatikana.' }, 404);
    }

    const keys = [event.image_key, event.video_key].filter(Boolean);

    const cleanup = await Promise.allSettled(
      keys.map(key => env.EVENTS_BUCKET.delete(key))
    );

    const failedKeys = keys.filter(
      (key, i) => cleanup[i].status === 'rejected'
    );

    if (failedKeys.length) {
      console.error('Event delete: cleanup failed for keys', failedKeys);

      return reply({
        success: true,
        cleanup_pending: true,
        message: 'Tukio limefutwa; baadhi ya faili zinahitaji kufutwa kwenye hifadhi.'
      });
    }

    return reply({
      success: true,
      cleanup_pending: false
    });

  } catch (error) {
    console.error('Event management error:', error);

    return reply({
      error: 'Imeshindikana kukamilisha ombi.'
    }, 500);
  }
}
    // NYG EVENTS - FUNGUA PICHA AU VIDEO
const eventMedia = path.match(
  /^\/api\/events\/media\/(\d+)\/(image|video)$/
);

if (eventMedia && (method === 'GET' || method === 'HEAD')) {
  if (!env.EVENTS_DB || !env.EVENTS_BUCKET) {
    return reply({ error: 'Hifadhi haijaunganishwa.' }, 503);
  }

  const id = Number(eventMedia[1]);

  if (!Number.isSafeInteger(id) || id < 1) {
    return reply({ error: 'ID si sahihi.' }, 400);
  }

  try {
    const event = await env.EVENTS_DB.prepare(
      'SELECT status, image_key, video_key FROM events WHERE id = ?'
    ).bind(id).first();

    if (!event ||
        (event.status !== 'published' &&
         !(await sessionValid(request, env)))) {
      return reply({ error: 'Faili haijapatikana.' }, 404);
    }

    const key = eventMedia[2] === 'image'
      ? event.image_key
      : event.video_key;

    if (!key) {
      return reply({ error: 'Faili haijapatikana.' }, 404);
    }

    const object = await env.EVENTS_BUCKET.get(key);

    if (!object) {
      return reply({ error: 'Faili haijapatikana.' }, 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');

    return new Response(
      method === 'HEAD' ? null : object.body,
      { headers }
    );

  } catch (error) {
    console.error('Event media error:', error);
    return reply({ error: 'Imeshindikana kufungua faili.' }, 500);
  }
}

// NYG EVENTS - ADMIN PUBLISH
if (path === '/api/events/admin/publish' && method === 'POST') {
  if (!(await sessionValid(request, env))) {
    return reply({ error: 'Tafadhali ingia kama admin.' }, 401);
  }

  if (!sameOrigin(request, url)) {
    return reply({ error: 'Forbidden origin' }, 403);
  }

  if (!env.EVENTS_DB) {
    return reply({ error: 'Database haijaunganishwa.' }, 503);
  }

  const data = await request.json().catch(() => null);
  const id = Number(data?.event_id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return reply({ error: 'ID si sahihi.' }, 400);
  }

  try {
    const result = await env.EVENTS_DB.prepare(
      "UPDATE events SET status = 'published', updated_at = datetime('now') WHERE id = ? AND status = 'draft'"
    ).bind(id).run();

    if (result.meta?.changes !== 1) {
      return reply({ error: 'Draft haijapatikana.' }, 404);
    }

    return reply({
      success: true,
      event_id: id,
      status: 'published'
    });

  } catch (error) {
    console.error('Event publish error:', error);
    return reply({ error: 'Imeshindikana kuchapisha tukio.' }, 500);
  }
}
    // NYG EVENTS - READ EVENTS API
    if (path === '/api/events' && method === 'GET') {
      try {
        if (!env.EVENTS_DB) {
          return reply({ error: 'Events database unavailable' }, 503);
        }

        const isAdmin = await sessionValid(request, env);

        const sql = isAdmin
          ? `SELECT id, title, description, event_date,
                    image_key, video_key, media_url,
                    status, created_at, updated_at
             FROM events
             ORDER BY created_at DESC, id DESC
             LIMIT 100`
          : `SELECT id, title, description, event_date,
                    image_key, video_key, media_url,
                    status, created_at, updated_at
             FROM events
             WHERE status = 'published'
             ORDER BY created_at DESC, id DESC
             LIMIT 100`;

        const result = await env.EVENTS_DB
          .prepare(sql)
          .all();

        return reply({
          success: true,
          events: result.results || []
        }, 200, {
          'Cache-Control': 'no-store'
        });

      } catch (error) {
        return reply({
          error: 'Failed to load events'
        }, 500);
      }
    }


        // NYG EVENTS - ADMIN CREATE DRAFT
if (path === '/api/events/admin/create' && method === 'POST') {
  if (!(await sessionValid(request, env))) {
    return reply({ error: 'Tafadhali ingia kama admin.' }, 401);
  }

  if (!sameOrigin(request, url)) {
    return reply({ error: 'Forbidden origin' }, 403);
  }

  if (!env.EVENTS_DB) {
    return reply({ error: 'Events database unavailable' }, 503);
  }

  const isMultipart = (request.headers.get('content-type') || '')
    .toLowerCase()
    .startsWith('multipart/form-data');

  const maxTotal = 55 * 1024 * 1024;
  let formData = null;
  let data;

  if (isMultipart) {
    const length = Number(request.headers.get('content-length'));

    if (!Number.isFinite(length) || length <= 0 || length > maxTotal) {
      return reply({ error: 'Ukubwa wa faili haukubaliki.' }, 413);
    }

    try {
      formData = await request.formData();
      data = Object.fromEntries(formData.entries());
    } catch {
      return reply({ error: 'Taarifa za faili si sahihi.' }, 400);
    }
  } else {
    data = await request.json().catch(() => null);
  }

  const title = typeof data?.title === 'string'
    ? data.title.trim() : '';

  const description = typeof data?.description === 'string'
    ? data.description.trim() : '';

  const eventDate = typeof data?.event_date === 'string'
    ? data.event_date.trim() : '';

  const mediaUrl = typeof data?.media_url === 'string'
    ? data.media_url.trim() : '';

  if (!title || !description ||
      title.length > 200 || description.length > 10000) {
    return reply({
      error: 'Kagua kichwa na maelezo ya tukio.'
    }, 400);
  }

  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    return reply({ error: 'Tarehe si sahihi.' }, 400);
  }

  if (mediaUrl) {
    if (mediaUrl.length > 2048) {
      return reply({ error: 'Link ni ndefu mno.' }, 400);
    }

    try {
      const link = new URL(mediaUrl);

      if (!['http:', 'https:'].includes(link.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch {
      return reply({ error: 'Link si sahihi.' }, 400);
    }
  }

  const files = [];

  if (formData) {
    for (const [field, allowed, limit] of [
      [
        'image',
        ['image/jpeg', 'image/png', 'image/webp'],
        5 * 1024 * 1024
      ],
      [
        'video',
        ['video/mp4', 'video/webm', 'video/quicktime'],
        50 * 1024 * 1024
      ]
    ]) {
      const value = formData.get(field);

      if (!value ||
          (typeof value !== 'string' && !value.name && !value.size)) {
        continue;
      }

      if (typeof value === 'string' ||
          !allowed.includes(value.type) ||
          !value.size ||
          value.size > limit) {
        return reply({
          error: `Faili ya ${field} si sahihi au ni kubwa mno.`
        }, 400);
      }

      files.push({
        field,
        value,
        key: `events/${field}/${crypto.randomUUID()}`
      });
    }
  }

  if (files.length && !env.EVENTS_BUCKET) {
    return reply({
      error: 'Hifadhi ya faili haijaunganishwa.'
    }, 503);
  }

  const uploaded = [];

  try {
    for (const file of files) {
      await env.EVENTS_BUCKET.put(
        file.key,
        await file.value.arrayBuffer(),
        {
          httpMetadata: {
            contentType: file.value.type
          }
        }
      );

      uploaded.push(file.key);
    }

    const result = await env.EVENTS_DB.prepare(`
      INSERT INTO events
        (title, description, event_date, media_url,
         image_key, video_key, status)
      VALUES (?, ?, ?, ?, ?, ?, 'draft')
    `).bind(
      title,
      description,
      eventDate || null,
      mediaUrl || null,
      files.find(file => file.field === 'image')?.key || null,
      files.find(file => file.field === 'video')?.key || null
    ).run();

    return reply({
      success: true,
      event_id: result.meta?.last_row_id,
      status: 'draft',
      message: 'Tukio limehifadhiwa kama Draft.'
    }, 201);

  } catch (error) {
    await Promise.allSettled(
      uploaded.map(key => env.EVENTS_BUCKET.delete(key))
    );

    console.error('NYG event create error:', error);

    return reply({
      error: 'Imeshindikana kuhifadhi tukio.'
    }, 500);
  }
}

    // NYG VIDEO HUB - PUBLIC VIDEO APIs
    if (path === '/api/video/views' || path === '/api/video/likes' || path === '/api/video/comments') {
      if (method !== 'GET' && method !== 'POST') {
        return reply({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
      }

      const videoId = url.searchParams.get('video');

      if (!videoId || !allowedVideos.has(videoId)) {
        return reply({ error: 'Invalid video ID' }, 400);
      }

      if (!env.DB) {
        return reply({ error: 'Database haijaunganishwa.' }, 503);
      }

      try {
        // VIDEO VIEWS
        if (path === '/api/video/views') {
          if (method === 'POST') {
            if (!sameOrigin(request, url)) {
              return reply({ error: 'Forbidden origin' }, 403);
            }

            const data = await request.json().catch(() => null);
            const visitorId = data?.visitor_id;

            if (!validVisitorId(visitorId)) {
              return reply({ error: 'Invalid visitor ID' }, 400);
            }

            const result = await env.DB.prepare(`
              INSERT INTO video_views (video_id, visitor_id)
              SELECT ?, ?
              WHERE NOT EXISTS (
                SELECT 1 FROM video_views
                WHERE video_id = ? AND visitor_id = ?
                  AND viewed_at > datetime('now', '-24 hours')
              )
            `).bind(videoId, visitorId, videoId, visitorId).run();

            return reply({
              success: true,
              counted: result.meta?.changes === 1
            });
          }

          const result = await env.DB.prepare(
            'SELECT COUNT(*) AS views FROM video_views WHERE video_id = ?'
          ).bind(videoId).first();

          return reply({
            video_id: videoId,
            views: result?.views ?? 0
          });
        }

        // VIDEO LIKES
        if (path === '/api/video/likes') {
          if (method === 'GET') {
            const result = await env.DB.prepare(
              'SELECT COUNT(*) AS likes FROM video_likes WHERE video_id = ?'
            ).bind(videoId).first();

            return reply({
              video_id: videoId,
              likes: result?.likes ?? 0
            });
          }

          if (!sameOrigin(request, url)) {
            return reply({ error: 'Forbidden origin' }, 403);
          }

          const data = await request.json().catch(() => null);
          const visitorId = data?.visitor_id;

          if (!validVisitorId(visitorId)) {
            return reply({ error: 'Invalid visitor ID' }, 400);
          }

          const result = await env.DB.prepare(
            'INSERT OR IGNORE INTO video_likes (video_id, visitor_id) VALUES (?, ?)'
          ).bind(videoId, visitorId).run();

          const total = await env.DB.prepare(
            'SELECT COUNT(*) AS likes FROM video_likes WHERE video_id = ?'
          ).bind(videoId).first();

          return reply({
            success: true,
            counted: result.meta?.changes === 1,
            likes: total?.likes ?? 0
          });
        }

        // VIDEO COMMENTS
        if (method === 'GET') {
          const rows = await env.DB.prepare(`
            SELECT id, commenter_name, comment_text, created_at
            FROM video_comments
            WHERE video_id = ?
            ORDER BY id DESC
            LIMIT 50
          `).bind(videoId).all();

          return reply({
            video_id: videoId,
            comments: rows.results || []
          });
        }

        if (!sameOrigin(request, url)) {
          return reply({ error: 'Forbidden origin' }, 403);
        }

        const length = Number(request.headers.get('content-length') || 0);

        if (length > 4096) {
          return reply({ error: 'Comment request too large' }, 413);
        }

        const data = await request.json().catch(() => null);
        const name = typeof data?.commenter_name === 'string'
          ? data.commenter_name.trim() : '';
        const comment = typeof data?.comment_text === 'string'
          ? data.comment_text.trim() : '';

        if (name.length < 1 || name.length > 60 || comment.length < 2 || comment.length > 1000) {
          return reply({ error: 'Jina liwe herufi 1–60 na maoni herufi 2–1000.' }, 400);
        }

        if (/[\u0000-\u001f\u007f]/.test(name) ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(comment)) {
          return reply({ error: 'Invalid characters' }, 400);
        }

      
const visitorId = data?.visitor_id;

if (!validVisitorId(visitorId)) {
  return reply({ error: 'Invalid visitor ID' }, 400);
}

const existingUser = await env.DB.prepare(
  'SELECT commenter_name FROM video_comment_users WHERE visitor_id = ?'
).bind(visitorId).first();

if (existingUser && existingUser.commenter_name !== name) {
  return reply({
    error: 'Tumia jina lako la awali kwenye NYG VIDEO HUB.'
  }, 409);
}

const savedUser = await env.DB.prepare(
  'SELECT commenter_name FROM video_comment_users WHERE visitor_id = ?'
).bind(visitorId).first();

if (savedUser && savedUser.commenter_name !== name) {
  return reply({ error: 'Jina lako tayari limesajiliwa.' }, 409);
}

await env.DB.batch([
  env.DB.prepare(
    'INSERT OR IGNORE INTO video_comment_users (visitor_id, commenter_name) VALUES (?, ?)'
  ).bind(visitorId, name),

  env.DB.prepare(
    `INSERT INTO video_comments
    (video_id, commenter_name, comment_text, visitor_id)
    SELECT ?, commenter_name, ?, visitor_id
    FROM video_comment_users
    WHERE visitor_id = ?`
  ).bind(videoId, comment, visitorId)
]);


        return reply({ success: true }, 201);

      } catch (error) {
        console.error('NYG video API error', error);
        return reply({
          error: 'Video API imeshindwa. Kagua Worker logs na D1 schema.'
        }, 500);
      }
    }

    // NYG VIDEO HUB - ADMIN DELETE COMMENT
    if (path === '/api/video/admin/delete-comment') {
      if (method !== 'POST') {
        return reply({ error: 'Method not allowed' }, 405);
      }

      if (!(await sessionValid(request, env))) {
        return reply({ error: 'Admin pekee anaruhusiwa.' }, 403);
      }

      if (!sameOrigin(request, url)) {
        return reply({ error: 'Forbidden origin' }, 403);
      }

      if (!env.DB) {
        return reply({ error: 'Database haijaunganishwa.' }, 503);
      }

      try {
        const data = await request.json();
        const commentId = Number(data?.comment_id);

        if (!Number.isSafeInteger(commentId) || commentId <= 0) {
          return reply({ error: 'Invalid comment ID' }, 400);
        }

        const result = await env.DB.prepare(
          'DELETE FROM video_comments WHERE id = ?'
        ).bind(commentId).run();

        if (result.meta?.changes !== 1) {
          return reply({ error: 'Comment haijapatikana.' }, 404);
        }

        return reply({ success: true });
      } catch (error) {
        console.error('Video comment delete error:', error);
        return reply({ error: 'Imeshindikana kufuta comment.' }, 500);
      }
    }

    // ADMIN LOGIN
    // NYG SHUHUDA - ADMIN SESSION CHECK
if (path === '/api/testimonies/admin/session' &&
    method === 'GET') {

  const authenticated = await sessionValid(request, env);

  return reply({
    authenticated: authenticated
  });
}
    // NYG SHUHUDA - PUBLIC TESTIMONIES
    if (path === '/api/testimonies' && method === 'GET') {
      if (!env.TESTIMONIES_DB) {
        return reply({ error: 'Testimonies database haijaunganishwa.' }, 503);
      }

      try {
        const result = await env.TESTIMONIES_DB.prepare(`
          SELECT id, testimony_number, witness_name,
                 testimony_text, audio_key, created_at
          FROM nyg_testimonies
          WHERE status = 'approved'
          ORDER BY id DESC
          LIMIT 50
        `).all();

        return reply({ testimonies: result.results || [] });
      } catch (error) {
        console.error('NYG testimonies error', error);
        return reply({ error: 'Shuhuda hazijapatikana.' }, 500);
      }
    }

    // NYG SHUHUDA - PUBLIC COMMENTS
    if (path === '/api/testimonies/comments' && method === 'GET') {
      if (!env.TESTIMONIES_DB) {
        return reply({ error: 'Testimonies database haijaunganishwa.' }, 503);
      }

      
    try {
      const result = await env.TESTIMONIES_DB.prepare(`
        SELECT id, commenter_name, comment_text, created_at
        FROM nyg_testimony_group_comments
        WHERE status = 'approved'
        ORDER BY id DESC
        LIMIT 100
      `).all();


        return reply({ comments: result.results || [] });
      } catch (error) {
        console.error('NYG testimony comments error', error);
        return reply({ error: 'Comments hazijapatikana.' }, 500);
      }
    }
  // NYG SHUHUDA - PUBLIC COMMENT SUBMISSION
if (path === '/api/testimonies/comments' && method === 'POST') {
  if (!sameOrigin(request, url)) {
    return reply({ error: 'Forbidden origin' }, 403);
  }

  if (!env.TESTIMONIES_DB) {
    return reply({ error: 'Database haijaunganishwa.' }, 503);
  }

  const length = Number(request.headers.get('content-length') || 0);
  if (length > 4096) {
    return reply({ error: 'Maoni ni makubwa sana.' }, 413);
  }

  const body = await request.json().catch(() => null);

  const name = typeof body?.commenter_name === 'string'
    ? body.commenter_name.trim() : '';
  const comment = typeof body?.comment_text === 'string'
    ? body.comment_text.trim() : '';
  
if (
  name.length < 2 || name.length > 60 ||
  comment.length < 2 || comment.length > 1000
) {
  return reply({ error: 'Taarifa za comment si sahihi.' }, 400);
}


  if (/[\u0000-\u001f\u007f]/.test(name) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(comment)) {
    return reply({ error: 'Maandishi yana alama zisizoruhusiwa.' }, 400);
  }

  
try {
  await env.TESTIMONIES_DB.prepare(`
    INSERT INTO nyg_testimony_group_comments
    (commenter_name, comment_text, status)
    VALUES (?, ?, 'approved')
  `).bind(name, comment).run();

    return reply({
      success: true,
      message: 'Asante! Maoni yako yamechapishwa kwenye NYG SHUHUDA.'
    }, 201);

  } catch (error) {
    console.error('NYG testimony submission error', error);
    return reply({ error: 'Imeshindikana kuhifadhi maoni.' }, 500);
  }
}  
    
    if (path === '/api/admin/login' && method === 'POST') {
      if (!sameOrigin(request, url)) {
        return reply({ error: 'Forbidden origin' }, 403);
      }

      if (!env.ADMIN_ACCESS_CODE || !env.ADMIN_SESSION_SECRET) {
        return reply({ error: 'Admin login bado haijawekwa kwenye server.' }, 503);
      }

      const body = await request.json().catch(() => ({}));

      if (body.code !== env.ADMIN_ACCESS_CODE) {
        return reply({ error: 'Access code si sahihi.' }, 401);
      }

      const expires = String(Date.now() + 8 * 60 * 60 * 1000);
      const token = `${expires}.${await sign(expires, env.ADMIN_SESSION_SECRET)}`;

      return reply({ ok: true }, 200, {
        'set-cookie': `nyg_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`
      });
    }

    // ADMIN LOGOUT
    if (path === '/api/admin/logout' && method === 'POST') {
      return reply({ ok: true }, 200, {
        'set-cookie': 'nyg_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
      });
    }

    // CLICKPESA STATUS
    if (path === '/api/clickpesa/status' && method === 'GET') {
      return reply({
        connected: Boolean(env.CLICKPESA_CLIENT_ID && env.CLICKPESA_API_KEY)
      });
    }

    // PROTECTED ADMIN APIs
    // NYG SHUHUDA - PUBLIC AUDIO PLAYBACK
if (path.startsWith('/api/testimonies/audio/') &&
    (method === 'GET' || method === 'HEAD')) {

  if (!env.TESTIMONIES_DB || !env.TESTIMONIES_BUCKET) {
    return reply({
      error: 'Audio storage haijaunganishwa.'
    }, 503);
  }

  const testimonyId = Number(
    path.slice('/api/testimonies/audio/'.length)
  );

  if (!Number.isSafeInteger(testimonyId) || testimonyId < 1) {
    return reply({ error: 'Invalid testimony ID' }, 400);
  }

  try {
    const testimony = await env.TESTIMONIES_DB.prepare(`
      SELECT audio_key
      FROM nyg_testimonies
      WHERE id = ? AND status = 'approved'
    `).bind(testimonyId).first();

    if (!testimony?.audio_key) {
      return reply({ error: 'Audio haijapatikana.' }, 404);
    }

    const audio = await env.TESTIMONIES_BUCKET.get(
      testimony.audio_key
    );

    if (!audio) {
      return reply({ error: 'Audio haijapatikana R2.' }, 404);
    }

    const headers = new Headers();
    audio.writeHttpMetadata(headers);
    headers.set('Content-Type',
      headers.get('Content-Type') || 'audio/mpeg');
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Accept-Ranges', 'none');

    return new Response(
      method === 'HEAD' ? null : audio.body,
      { status: 200, headers }
    );

  } catch (error) {
    console.error('NYG testimony audio error:', error);
    return reply({
      error: 'Imeshindikana kufungua audio.'
    }, 500);
  }
}
    // NYG JOBS - PUBLIC JOB LIST
    if (path === '/api/jobs' && method === 'GET') {
      if (!env.JOBS_DB) {
        return reply({ error: 'Jobs database haijaunganishwa.' }, 503);
      }

      try {
        const result = await env.JOBS_DB.prepare(`
          SELECT id, title, company, location,
                 description, requirements,
                 application_link, contact_email,
                 deadline, published_at
          FROM jobs
          WHERE status = 'published'
          ORDER BY published_at DESC, id DESC
          LIMIT 50
        `).all();

        return reply({ jobs: result.results || [] });
      } catch (error) {
        console.error('NYG Jobs list error:', error);
        return reply({ error: 'Imeshindikana kupata kazi.' }, 500);
      }
    }
    
    // NYG JOBS - PUBLIC APPLICATION SUBMISSION
    if (path === '/api/jobs/apply' && method === 'POST') {
      if (!env.JOBS_DB) {
        return reply({ error: 'Database haijaunganishwa.' }, 503);
      }

      if (!sameOrigin(request, url)) {
        return reply({ error: 'Forbidden origin' }, 403);
      }

      const contentType = request.headers.get('Content-Type') || '';
      if (!contentType.toLowerCase().includes('application/json')) {
        return reply({ error: 'Tuma taarifa za JSON.' }, 415);
      }

      const contentLength = Number(request.headers.get('Content-Length') || 0);
      if (contentLength > 12000) {
        return reply({ error: 'Taarifa ni kubwa mno.' }, 413);
      }

      try {
        const raw = await request.text();
        if (raw.length > 12000) {
          return reply({ error: 'Taarifa ni kubwa mno.' }, 413);
        }

        const data = JSON.parse(raw);

        const jobId = Number(data.job_id);
        const fullName = String(data.full_name || '').trim();
        const phone = String(data.phone || '').trim();
        const email = String(data.email || '').trim();
        const education = String(data.education || '').trim();
        const experience = String(data.experience || '').trim();

        if (!Number.isSafeInteger(jobId) || jobId <= 0) {
          return reply({ error: 'Chagua nafasi halali ya kazi.' }, 400);
        }

        if (fullName.length < 2 || fullName.length > 120 ||
            phone.length < 7 || phone.length > 25 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
            email.length > 254 ||
            education.length > 1500 ||
            experience.length > 2000) {
          return reply({ error: 'Kagua taarifa ulizojaza.' }, 400);
        }

        const job = await env.JOBS_DB.prepare(
          "SELECT id FROM jobs WHERE id = ? AND status = 'published' AND (deadline IS NULL OR deadline = '' OR deadline >= date('now'))"
        ).bind(jobId).first();

        if (!job) {
          return reply({ error: 'Nafasi hii haipatikani kwa maombi.' }, 404);
        }

        const result = await env.JOBS_DB.prepare(
          `INSERT INTO job_applications
           (job_id, full_name, phone, email, education, experience)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          jobId, fullName, phone, email, education, experience
        ).run();

        return reply({
          success: true,
          application_id: result.meta.last_row_id,
          message: 'Ombi lako limepokelewa.'
        }, 201);

      } catch (error) {
        console.error('NYG job application error:', error);
        return reply({
          error: 'Imeshindikana kupokea ombi. Jaribu tena.'
        }, 500);
      }
    }


    if (path.startsWith('/api/')) {
      if (!await sessionValid(request, env)) {
        return reply({ error: 'Tafadhali ingia kama admin.' }, 401);
      }

      if (method === 'POST' && !sameOrigin(request, url)) {
        return reply({ error: 'Forbidden origin' }, 403);
      }

      
    // NYG JOBS - ADMIN CREATE JOB
    if (path === '/api/jobs/admin/create' && method === 'POST') {
      if (!env.JOBS_DB) {
        return reply({ error: 'Jobs database haijaunganishwa.' }, 503);
      }

      try {
        const data = await request.json();

        const title = String(data.title || '').trim();
        const company = String(data.company || '').trim();
        const location = String(data.location || '').trim();
        const description = String(data.description || '').trim();
        const requirements = String(data.requirements || '').trim();
        const applicationLink = String(data.application_link || '').trim();
        const contactEmail = String(data.contact_email || '').trim();
        const deadline = String(data.deadline || '').trim();

        if (!title || !company || !description) {
          return reply({
            error: 'Jina la kazi, kampuni na maelezo vinahitajika.'
          }, 400);
        }

        if (title.length > 200 || company.length > 200 ||
            description.length > 10000) {
          return reply({ error: 'Maandishi yamezidi kiwango.' }, 400);
        }

        if (applicationLink) {
          try {
            const link = new URL(applicationLink);
            if (!['https:', 'http:'].includes(link.protocol)) {
              throw new Error('Invalid protocol');
            }
          } catch {
            return reply({ error: 'Link ya maombi si sahihi.' }, 400);
          }
        }

        if (contactEmail &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
          return reply({ error: 'Email si sahihi.' }, 400);
        }

        const result = await env.JOBS_DB.prepare(`
          INSERT INTO jobs (
            title, company, location, description,
            requirements, application_link, contact_email,
            deadline, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft',
                  datetime('now'), datetime('now'))
        `).bind(
          title, company, location || null, description,
          requirements || null, applicationLink || null,
          contactEmail || null, deadline || null
        ).run();

        return reply({
          success: true,
          job_id: result.meta.last_row_id,
          message: 'Tangazo limehifadhiwa kama draft.'
        }, 201);

      } catch (error) {
        console.error('NYG Jobs create error:', error);
        return reply({
          error: 'Imeshindikana kuhifadhi tangazo.'
        }, 500);
      }
    }

  // NYG SHUHUDA - ADMIN AUDIO UPLOAD
if (path === '/api/testimonies/admin/upload' &&
    method === 'POST') {

  if (!env.TESTIMONIES_DB || !env.TESTIMONIES_BUCKET) {
    return reply({
      error: 'Database au Audio Storage haijaunganishwa.'
    }, 503);
  }

  const maxSize = 25 * 1024 * 1024;
  const length = Number(
    request.headers.get('content-length') || 0
  );

  if (length > maxSize + 10000) {
    return reply({ error: 'Audio imezidi MB 25.' }, 413);
  }

  const form = await request.formData().catch(() => null);

  if (!form) {
    return reply({ error: 'Fomu si sahihi.' }, 400);
  }

  const name = String(form.get('witness_name') || '').trim();
  const description = String(
    form.get('testimony_text') || ''
  ).trim();

  const file = form.get('audio');

  if (!name || name.length > 100 ||
      !description || description.length > 1000 ||
      !file || typeof file.arrayBuffer !== 'function') {
    return reply({
      error: 'Weka jina, maelezo na audio ya shuhuda.'
    }, 400);
  }

  const formats = {
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm'
  };

  const type = file.type.toLowerCase();
  const extension = formats[type];

  if (!extension) {
    return reply({
      error: 'Tumia MP3, M4A, WAV, OGG au WebM.'
    }, 415);
  }

  if (file.size === 0 || file.size > maxSize) {
    return reply({
      error: 'Audio iwe na ukubwa usiozidi MB 25.'
    }, 413);
  }

  const audio = await file.arrayBuffer();

  if (audio.byteLength > maxSize) {
    return reply({ error: 'Audio imezidi MB 25.' }, 413);
  }

  const key = `testimonies/${crypto.randomUUID()}.${extension}`;

  try {
    await env.TESTIMONIES_BUCKET.put(key, audio, {
      httpMetadata: { contentType: type }
    });

    const result = await env.TESTIMONIES_DB.prepare(`
      INSERT INTO nyg_testimonies
      (witness_name, testimony_text, audio_key, status)
      VALUES (?, ?, ?, 'approved')
    `).bind(name, description, key).run();

    return reply({
      success: true,
      id: result.meta?.last_row_id,
      message: 'Audio ya shuhuda imehifadhiwa.'
    }, 201);

  } catch (error) {
    console.error('NYG testimony upload:', error);

    await env.TESTIMONIES_BUCKET.delete(key).catch(
      cleanupError => console.error(
        'Audio cleanup failed:', cleanupError
      )
    );

    return reply({
      error: 'Imeshindikana kuhifadhi shuhuda.'
    }, 500);
  }
}    
// NYG SHUHUDA - ADMIN DELETE COMMENT  
if (path === '/api/testimonies/admin/delete-comment' &&
    method === 'POST') {

  if (!sameOrigin(request, url)) {
    return reply({ error: 'Forbidden origin' }, 403);
  }

  if (!env.TESTIMONIES_DB) {
    return reply({ error: 'Database haijaunganishwa.' }, 503);
  }

  const body = await request.json().catch(() => null);
  const commentId = body?.comment_id;

  if (!Number.isSafeInteger(commentId) || commentId < 1) {
    return reply({ error: 'Comment ID si sahihi.' }, 400);
  }

  try {
    const result = await env.TESTIMONIES_DB.prepare(
      'DELETE FROM nyg_testimony_group_comments WHERE id = ?'
    ).bind(commentId).run();

    if (result.meta?.changes !== 1) {
      return reply({ error: 'Comment haijapatikana.' }, 404);
    }

    return reply({
      success: true,
      message: 'Comment imefutwa.'
    });

  } catch (error) {
    console.error('NYG testimony delete error', error);
    return reply({ error: 'Imeshindikana kufuta comment.' }, 500);
  }
}
      
    
      // CLICKPESA TEST
      if (path === '/api/clickpesa/test' && method === 'POST') {
        try {
          const response = await fetch(
            'https://api.clickpesa.com/third-parties/generate-token',
            {
              method: 'POST',
              headers: {
                'api-key': env.CLICKPESA_API_KEY,
                'client-id': env.CLICKPESA_CLIENT_ID
              }
            }
          );

          return reply({
            authenticated: response.ok,
            status: response.status
          });

        } catch (error) {
          return reply({
            authenticated: false,
            error: 'ClickPesa haijafikiwa'
          }, 502);
        }
      }

      // ADMIN STATUS
      if (path === '/api/admin/status' && method === 'GET') {
        return reply({
          aiConfigured: Boolean(env.ELEVENLABS_API_KEY)
        });
      }

      // MUSIC HISTORY
      if (path === '/api/music/history' && method === 'GET') {
        const listed = await env.MUSIC_BUCKET.list({
          prefix: 'generated/',
          limit: 50
        });

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

      // HUMMING UPLOAD
      if (path === '/api/humming/upload' && method === 'POST') {
        const type = (request.headers.get('content-type') || '')
          .split(';')[0].toLowerCase();

        const allowed = new Map([
          ['audio/webm', 'webm'],
          ['audio/ogg', 'ogg'],
          ['audio/mp4', 'm4a'],
          ['audio/mpeg', 'mp3'],
          ['audio/wav', 'wav'],
          ['audio/x-wav', 'wav']
        ]);

        if (!allowed.has(type)) {
          return reply({ error: 'Tuma audio ya WebM, OGG, M4A, MP3 au WAV.' }, 415);
        }

        const length = Number(request.headers.get('content-length') || 0);

        if (length > 15 * 1024 * 1024) {
          return reply({ error: 'Recording imezidi MB 15.' }, 413);
        }

        const audio = await request.arrayBuffer();

        if (audio.byteLength > 15 * 1024 * 1024) {
          return reply({ error: 'Recording imezidi MB 15.' }, 413);
        }

        const id = crypto.randomUUID();
        const key = `references/${id}.${allowed.get(type)}`;

        await env.MUSIC_BUCKET.put(key, audio, {
          httpMetadata: { contentType: type }
        });

        return reply({
          id,
          url: `/music/${encodeURIComponent(key)}`
        });
      }

      // AI MUSIC GENERATION
      if (path === '/api/music/generate' && method === 'POST') {
        if (!env.ELEVENLABS_API_KEY) {
          return reply({ error: 'AI engine bado haijaunganishwa.' }, 503);
        }

        const b = await request.json().catch(() => ({}));
        const duration = Math.min(180, Math.max(30, Number(b.duration) || 30));
        const bpm = Math.min(180, Math.max(50, Number(b.bpm) || 96));

        const prompt = `${String(b.prompt || '').slice(0, 1800)}. ${b.genre} style, ${b.mood} mood, ${b.key}, ${bpm} BPM. Instruments: ${String(b.instruments || 'piano, bass and drums').slice(0, 300)}. Instrumental only, no lead vocals.`;

        if (prompt.length < 40) {
          return reply({ error: 'Andika maelezo ya muziki kwanza.' }, 400);
        }

        const ai = await fetch(
          'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'xi-api-key': env.ELEVENLABS_API_KEY
            },
            body: JSON.stringify({
              prompt,
              music_length_ms: duration * 1000,
              model_id: 'music_v2'
            })
          }
        );

        if (!ai.ok) {
          return reply({
            error: `AI generation imeshindwa (${ai.status}). Credits hazitakatwa tena bila kukagua.`
          }, 502);
        }

        const id = crypto.randomUUID();
        const key = `generated/${id}.mp3`;

        await env.MUSIC_BUCKET.put(key, ai.body, {
          httpMetadata: {
            contentType: 'audio/mpeg',
            contentDisposition: `attachment; filename="nyg-ai-${id}.mp3"`
          }
        });

        return reply({
          id,
          url: `/music/${key}`
        });
      }

      return reply({ error: 'API route haijapatikana.' }, 404);
    }

    // MUSIC FILE DELIVERY
    if (path.startsWith('/music/')) {
      if (!await sessionValid(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }

      const key = decodeURIComponent(path.slice(7));
      const object = await env.MUSIC_BUCKET.get(key);

      if (!object) {
        return new Response('Audio haijapatikana.', { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);

      return new Response(object.body, { headers });
    }

    // NYG ARTIST BIOGRAPHY - DEDICATED PAGE & SOCIAL SHARING
    if (path === '/artist/nyg-worship' ||
        path === '/artist/nyg-worship/') {

      if (method !== 'GET' && method !== 'HEAD') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD' }
        });
      }

      const pageUrl = new URL('/index.html', request.url);
      const assetResponse = await env.ASSETS.fetch(
        new Request(pageUrl, request)
      );

      if (!assetResponse.ok) return assetResponse;

      const title = 'NYG WORSHIP | Artist Biography';
      const description =
        'Fahamu historia, huduma, nyimbo na mafanikio ya NYG WORSHIP kutoka Songea, Tanzania.';

      const imageUrl =
        'https://nygmusichub.com/nyg-worship-team-management.jpg';

      const shareUrl =
        'https://nygmusichub.com/artist/nyg-worship';

      const tags = {
        'og:title': title,
        'og:description': description,
        'og:image': imageUrl,
        'og:url': shareUrl,
        'og:type': 'article',
        'twitter:card': 'summary_large_image',
        'twitter:title': title,
        'twitter:description': description,
        'twitter:image': imageUrl
      };

      const rewriter = new HTMLRewriter();

      for (const [property, content] of Object.entries(tags)) {
        const attribute = property.startsWith('twitter:')
          ? 'name'
          : 'property';

        rewriter.on(`meta[${attribute}="${property}"]`, {
          element(element) {
            element.setAttribute('content', content);
          }
        });
      }

      // Ongeza tags zinazokosekana kwenye HTML.
      rewriter.on('head', {
        element(element) {
          const meta = Object.entries(tags).map(([key, value]) => {
            const attribute = key.startsWith('twitter:')
              ? 'name'
              : 'property';

            const escaped = value.replace(/&/g, '&amp;')
              .replace(/"/g, '&quot;')
              .replace(/</g, '&lt;');

            return `<meta ${attribute}="${key}" content="${escaped}">`;
          }).join('');

          element.append(meta, { html: true });
        }
      });

      const response = rewriter.transform(assetResponse);
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }


    // NYG VIDEO HUB - SOCIAL SHARING
    if (path === '/') {
      const newUrl = new URL('/index.html', request.url);
      const assetResponse = await env.ASSETS.fetch(
        new Request(newUrl, request)
      );

      const videoId = url.searchParams.get('video');

      // Homepage ibaki na metadata yake ya kawaida.
      if (!videoId ||
          !Object.prototype.hasOwnProperty.call(videos, videoId) ||
          !assetResponse.ok) {
        return assetResponse;
      }

      const title = videos[videoId];
      const imageUrl = videoId === 'EwOFoJZerDs'
        ? 'https://www.nygmusichub.com/Azzo%20maombi%20cover.jpg'
        : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

      const shareUrl =
        `https://www.nygmusichub.com/?video=${encodeURIComponent(videoId)}`;

      const tags = {
        'og:title': title + ' | NYG VIDEO HUB',
        'og:description': 'Tazama ' + title + ' kupitia NYG VIDEO HUB.',
        'og:image': imageUrl,
        'og:url': shareUrl,
        'og:type': 'video.other',
        'twitter:card': 'summary_large_image',
        'twitter:title': title + ' | NYG VIDEO HUB',
        'twitter:description': 'Tazama ' + title + ' kupitia NYG VIDEO HUB.',
        'twitter:image': imageUrl
      };

      const escapeHtml = value => String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');

      const rewriter = new HTMLRewriter();

      // Ondoa metadata za zamani ili zisishindane.
      rewriter.on('meta[property^="og:"]', {
        element(element) {
          element.remove();
        }
      });

      rewriter.on('meta[name^="twitter:"]', {
        element(element) {
          element.remove();
        }
      });

      // Weka metadata moja sahihi kwa kila video.
      rewriter.on('head', {
        element(element) {
          const meta = Object.entries(tags)
            .map(([key, value]) => {
              const attribute = key.startsWith('twitter:')
                ? 'name'
                : 'property';

              return `<meta ${attribute}="${key}" content="${escapeHtml(value)}">`;
            })
            .join('\n');

          element.append(meta, { html: true });
        }
      });

      const response = rewriter.transform(assetResponse);
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    // STATIC WEBSITE ASSETS
    return env.ASSETS.fetch(request);
  }
};
