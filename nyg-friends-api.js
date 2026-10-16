
const ALLOWED_ORIGIN = "https://nyg-friends-dev.pages.dev";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes, b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const iterations = 310000;

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    key,
    256
  );

  return `pbkdf2_sha256$${iterations}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && email.length <= 254;
}

function memberId() {
  const random = bytesToHex(
    crypto.getRandomValues(new Uint8Array(12))
  ).toUpperCase();

  return "NYGF-" + random;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed" }, 403);
    }

    if (request.method === "OPTIONS") {
      if (url.pathname !== "/api/signup") {
        return json({ error: "Not found" }, 404);
      }

      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // HEALTH CHECK
    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return json({
          error: "Method not allowed"
        }, 405);
      }

      if (!env.DB) {
        return json({
          ok: false,
          error: "D1 binding missing"
        }, 503);
      }

      try {
        await env.DB.prepare("SELECT 1").first();

        return json({
          ok: true,
          service: "NYG FRIENDS DEV API",
          database: "connected"
        });
      } catch {
        return json({
          ok: false,
          error: "Database unavailable"
        }, 503);
      }
    }

    // SIGNUP ENDPOINT
    if (url.pathname !== "/api/signup") {
      return json({
        error: "Endpoint not found"
      }, 404);
    }

    if (request.method !== "POST") {
      return json({
        error: "Method not allowed"
      }, 405);
    }

    if (!env.DB) {
      return json({
        error: "Database haijaunganishwa"
      }, 503);
    }

    if (
      !env.RATE_LIMIT_SECRET ||
      env.RATE_LIMIT_SECRET.length < 32
    ) {
      return json({
        error: "Security configuration missing"
      }, 503);
    }

    const contentType =
      request.headers.get("Content-Type") || "";

    if (
      !contentType.toLowerCase()
        .includes("application/json")
    ) {
      return json({
        error: "JSON required"
      }, 415);
    }

    const contentLength = Number(
      request.headers.get("Content-Length") || 0
    );

    if (contentLength > 4096) {
      return json({
        error: "Request too large"
      }, 413);
    }

    let data;

    try {
      const body = await request.text();

      if (new TextEncoder().encode(body).length > 4096) {
        return json({
          error: "Request too large"
        }, 413);
      }

      data = JSON.parse(body);
    } catch {
      return json({
        error: "JSON si sahihi"
      }, 400);
    }

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      return json({
        error: "Taarifa si sahihi"
      }, 400);
    }

    const {
      fullName,
      email,
      password,
      confirmPassword,
      acceptedTerms
    } = data;

    if (
      typeof fullName !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof confirmPassword !== "string"
    ) {
      return json({
        error: "Jaza taarifa zote"
      }, 400);
    }

    const name = fullName.trim().replace(/\s+/g, " ");
    const mail = email.trim().toLowerCase();

    if (name.length < 3 || name.length > 100) {
      return json({
        error: "Jina liwe na herufi 3 hadi 100"
      }, 400);
    }

    if (!validEmail(mail)) {
      return json({
        error: "Email si sahihi"
      }, 400);
    }

    if (
      password.length < 12 ||
      password.length > 128
    ) {
      return json({
        error: "Password iwe na herufi 12 hadi 128"
      }, 400);
    }

    if (password !== confirmPassword) {
      return json({
        error: "Password hazifanani"
      }, 400);
    }

    if (acceptedTerms !== true) {
      return json({
        error: "Kubali masharti na sera ya faragha"
      }, 400);
    }

    try {
      const ip = request.headers.get("CF-Connecting-IP");

      if (!ip) {
        return json({
          error: "Imeshindikana kuthibitisha ombi"
        }, 400);
      }

      const ipHash = await sha256(
        env.RATE_LIMIT_SECRET + ":" + ip
      );

      const now = Date.now();
      const windowStart = now - 3600000;

      const attempts = await env.DB.prepare(
        `SELECT COUNT(*) AS total
         FROM signup_attempts
         WHERE ip_hash = ? AND created_at > ?`
      ).bind(ipHash, windowStart).first();

      if (Number(attempts?.total || 0) >= 5) {
        return json({
          error: "Majaribio mengi. Jaribu baada ya saa moja."
        }, 429);
      }

      await env.DB.prepare(
        `INSERT INTO signup_attempts
         (ip_hash, created_at)
         VALUES (?, ?)`
      ).bind(ipHash, now).run();

      const existing = await env.DB.prepare(
        "SELECT id FROM members WHERE email = ?"
      ).bind(mail).first();

      if (existing) {
        return json({
          error: "Email hii tayari imesajiliwa"
        }, 409);
      }

      const passwordHash = await hashPassword(password);
      
      const member = memberId();

      const verificationToken = bytesToHex(
        crypto.getRandomValues(new Uint8Array(32))
      );

      const tokenHash = await sha256(verificationToken);
      const expiresAt = now + 86400000;

      await env.DB.prepare(
  `INSERT INTO members (
    member_id,
    full_name,
    email,
    password_hash,
    email_verified,
    verification_token_hash,
    verification_expires_at
  ) VALUES (?, ?, ?, ?, 0, ?, ?)`
).bind(
  member,
  name,
  mail,
  passwordHash,
  tokenHash,
  expiresAt
).run();

      // Email verification delivery will be added later.
      // Never return the verification token to visitors.

      return json({
        success: true,
        message:
          "Usajili umehifadhiwa. Uthibitisho wa email bado haujawezeshwa.",
        status: "pending_verification"
      }, 201);

    } catch (error) {
      console.error("NYG signup failed:", error.name);

      if (
        String(error.message || "").includes("UNIQUE")
      ) {
        return json({
          error: "Akaunti tayari ipo au ID imejirudia"
        }, 409);
      }

      return json({
        error: "Hitilafu ya mfumo. Jaribu baadaye."
      }, 500);
    }
  }
};
