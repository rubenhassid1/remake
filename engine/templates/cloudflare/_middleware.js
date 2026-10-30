// Passcode gate for this remake (Cloudflare Pages Function).
// Every page, file and the /_remake/ proof pages stay private until the passcode is entered.
// The passcode lives in the REMAKE_PASSCODE secret on Cloudflare Pages. Remove it to open the site.

const COOKIE = "remake_pass";
const ROBOTS = { "x-robots-tag": "noindex, nofollow" };

async function digest(text) {
  const data = new TextEncoder().encode("remake:" + text.trim().toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function gate(url, wrong) {
  const nextPath = url.pathname.startsWith("/_remake/gate") ? "/" : url.pathname + url.search;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Private preview</title>
<style>:root{--ink:#15171b;--muted:#5b626d;--line:#dde0e5;--accent:#ff5a1f}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
form{background:#fff;border:1px solid var(--line);border-radius:14px;padding:28px;width:min(100%,380px);display:grid;gap:14px}h1{font:800 24px/1.1 inherit;letter-spacing:-.03em;margin:0}p{margin:0;color:var(--muted)}
input{font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:8px}input:focus{outline:2px solid var(--accent);outline-offset:1px}button{font:600 15px/1 inherit;letter-spacing:-.01em;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px;cursor:pointer}.err{color:#c4321b}</style></head>
<body><form method="post" action="/_remake/gate" data-remake-gate><h1>Private preview</h1><p>This site is a work in progress. Enter the passcode to see it.</p>${wrong ? '<p class="err">That passcode didn\'t work.</p>' : ""}
<input type="hidden" name="next" value="${nextPath.replace(/"/g, "&quot;")}"><input name="passcode" type="password" autocomplete="current-password" placeholder="Passcode" aria-label="Passcode" required autofocus><button type="submit">Open</button></form></body></html>`;
}

// Cloudflare's Response.headers can be immutable when it comes from `next()`; clone before setting.
function withRobots(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(ROBOTS)) out.headers.set(k, v);
  return out;
}

export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain", ...ROBOTS } });
  }
  const passcode = env.REMAKE_PASSCODE;
  if (!passcode) return withRobots(await next());
  const expected = await digest(passcode);

  if (url.pathname === "/_remake/gate" && request.method === "POST") {
    const form = await request.formData();
    const given = String(form.get("passcode") || "");
    let dest = String(form.get("next") || "/");
    if (!dest.startsWith("/") || dest.startsWith("//")) dest = "/";
    if ((await digest(given)) !== expected) {
      return new Response(null, { status: 303, headers: { location: dest + (dest.includes("?") ? "&" : "?") + "remake_wrong=1", ...ROBOTS } });
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: dest,
        "set-cookie": `${COOKIE}=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000`,
        ...ROBOTS,
      },
    });
  }

  const cookie = (request.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (cookie && cookie.slice(COOKIE.length + 1) === expected) return withRobots(await next());

  return new Response(gate(url, url.searchParams.has("remake_wrong")), {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...ROBOTS },
  });
}
