// Static server for this remake on Railway, with the same passcode gate as Remake's Vercel middleware.
// Every page, file and the /_remake/ proof pages stay private until the passcode is entered.
// The passcode lives in the REMAKE_PASSCODE variable on Railway. Remove it to open the site.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const COOKIE = "remake_pass";
const ROBOTS = { "x-robots-tag": "noindex, nofollow" };
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject", ".mp4": "video/mp4",
  ".webm": "video/webm", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".pdf": "application/pdf",
};

const digest = (text) => crypto.createHash("sha256").update("remake:" + String(text).trim().toLowerCase()).digest("hex");

function resolveFile(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split("?")[0].split("#")[0]); } catch { rel = urlPath.split("?")[0]; }
  const base = path.join(SITE, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!base.startsWith(SITE)) return null;
  for (const c of [base, path.join(base, "index.html"), base + ".html"]) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
function gatePage(url, wrong) {
  const nextPath = url.pathname.startsWith("/_remake/gate") ? "/" : url.pathname + url.search.replace(/[?&]remake_wrong=1/, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Private preview</title>
<style>:root{--ink:#15171b;--muted:#5b626d;--line:#dde0e5;--accent:#ff5a1f}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
form{background:#fff;border:1px solid var(--line);border-radius:14px;padding:28px;width:min(100%,380px);display:grid;gap:14px}h1{font:800 24px/1.1 inherit;letter-spacing:-.03em;margin:0}p{margin:0;color:var(--muted)}
input{font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:8px}input:focus{outline:2px solid var(--accent);outline-offset:1px}button{font:600 15px/1 inherit;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px;cursor:pointer}.err{color:#c4321b}</style></head>
<body><form method="post" action="/_remake/gate" data-remake-gate><h1>Private preview</h1><p>This site is a work in progress. Enter the passcode to see it.</p>${wrong ? '<p class="err">That passcode didn\'t work.</p>' : ""}
<input type="hidden" name="next" value="${esc(nextPath)}"><input name="passcode" type="password" autocomplete="current-password" placeholder="Passcode" aria-label="Passcode" required autofocus><button type="submit">Open</button></form></body></html>`;
}

function serveFile(req, res, url) {
  const file = resolveFile(url.pathname);
  if (!file) {
    const nf = path.join(SITE, "404.html");
    res.writeHead(404, { "content-type": "text/html; charset=utf-8", ...ROBOTS });
    return res.end(fs.existsSync(nf) ? fs.readFileSync(nf) : "Not found");
  }
  const size = fs.statSync(file).size;
  const headers = { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "accept-ranges": "bytes", "cache-control": "private, max-age=300", ...ROBOTS };
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return req.method === "HEAD" ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": size });
  return req.method === "HEAD" ? res.end() : fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain", ...ROBOTS });
    return res.end("User-agent: *\nDisallow: /\n");
  }
  const passcode = process.env.REMAKE_PASSCODE;
  if (!passcode) return serveFile(req, res, url);
  const expected = digest(passcode);

  if (url.pathname === "/_remake/gate" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      let dest = String(form.get("next") || "/");
      if (!dest.startsWith("/") || dest.startsWith("//")) dest = "/";
      const given = form.get("passcode") || "";
      const ok = crypto.timingSafeEqual(Buffer.from(digest(given)), Buffer.from(expected));
      if (!ok) {
        res.writeHead(303, { location: dest + (dest.includes("?") ? "&" : "?") + "remake_wrong=1", ...ROBOTS });
        return res.end();
      }
      res.writeHead(303, { location: dest, "set-cookie": `${COOKIE}=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000`, ...ROBOTS });
      res.end();
    });
    return;
  }

  const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (cookie && cookie.slice(COOKIE.length + 1) === expected) return serveFile(req, res, url);

  res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...ROBOTS });
  res.end(gatePage(url, url.searchParams.has("remake_wrong")));
});

server.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => console.log(`Remake serving site/ on port ${server.address().port}`));
