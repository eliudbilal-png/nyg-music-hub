export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/music/")) {
      const fileName = decodeURIComponent(
        url.pathname.replace("/music/", "")
      );

      const object = await env.MUSIC_BUCKET.get(fileName);

      if (object === null) {
        return new Response("Wimbo haujapatikana.", {
          status: 404
        });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);

      return new Response(object.body, {
        headers
      });
    }

    return env.ASSETS.fetch(request);
  }
};
