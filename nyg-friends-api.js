
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
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

    return json({
      ok: false,
      error: "Endpoint not found"
    }, 404);
  }
};
