// Images: never ship the original's pictures. For every image slot, Remake reads the picture's shape,
// colours and brightness, Claude writes what the new brand's picture should show (same framing, same
// mood), and a generator or a free stock library makes the replacement. Every result is credited.
//
//   remake images            brief: measure every image slot, write remake/images.json + contact sheets
//   remake images --make     make every briefed image (Codex on a ChatGPT plan, an API key, free stock, or generated art)
//   remake apply             puts them in the site
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "./spawn.mjs";
import { launch } from "./browser.mjs";
import { RemakeError, say, ok, warn, step, readJson, writeJson, ensureDir, sleep, UA_SUFFIX } from "./util.mjs";

const SKIP_GROUPS = new Set(["Logos", "Icons"]);

// ---------- measuring ----------

async function measure(page, file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : ext === ".svg" ? "image/svg+xml" : ext === ".avif" ? "image/avif" : "image/jpeg";
  const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    try {
      await img.decode();
    } catch (e) {
      return null;
    }
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    const px = [];
    let luma = 0;
    let sat = 0;
    const buckets = new Set();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      px.push([r, g, b]);
      luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat += mx ? (mx - mn) / mx : 0;
      buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
    if (!px.length) return null;
    // k-means, 5 colours
    let centers = [0, 0.25, 0.5, 0.75, 0.99].map((f) => px[Math.floor(f * (px.length - 1))].slice());
    let counts = [];
    for (let it = 0; it < 10; it++) {
      const sums = centers.map(() => [0, 0, 0]);
      counts = centers.map(() => 0);
      for (const p of px) {
        let best = 0, bd = Infinity;
        centers.forEach((c, k) => {
          const dd = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
          if (dd < bd) { bd = dd; best = k; }
        });
        counts[best]++;
        sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2];
      }
      centers = centers.map((c, k) => (counts[k] ? sums[k].map((s) => s / counts[k]) : c));
    }
    const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const palette = centers.map((c, k) => ({ c: hex(c), n: counts[k] })).sort((a, b) => b.n - a.n).map((x) => x.c);
    return {
      w: img.naturalWidth,
      h: img.naturalHeight,
      palette: [...new Set(palette)],
      brightness: Math.round(luma / px.length / 2.55),
      saturation: Math.round((100 * sat) / px.length),
      kind: buckets.size < 120 ? "graphic" : "photo",
    };
  }, dataUrl);
}

function orientation(w, h) {
  const r = w / h;
  return r > 1.15 ? "landscape" : r < 0.87 ? "portrait" : "square";
}

function describeLook(e) {
  const light = e.brightness > 66 ? "bright, airy" : e.brightness < 33 ? "dark, low-key" : "mid-tone";
  const colour = e.saturation < 18 ? "muted, near-monochrome" : e.saturation > 55 ? "saturated, vivid" : "natural colour";
  return `${e.orientation}, ${light}, ${colour}, palette ${e.palette.slice(0, 4).join(" ")}`;
}

async function contactSheets(page, entries, dir, root) {
  const sheets = [];
  for (let s = 0; s < entries.length; s += 20) {
    const part = entries.slice(s, s + 20);
    const cells = part
      .map((e) => {
        const data = fs.readFileSync(path.join(root, "site", e.file)).toString("base64");
        const ext = path.extname(e.file).slice(1).replace("jpg", "jpeg");
        return `<figure><img src="data:image/${ext === "svg" ? "svg+xml" : ext};base64,${data}"><figcaption><b>${e.id}</b> ${e.width}×${e.height} · ${e.kind}</figcaption></figure>`;
      })
      .join("");
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.setContent(`<html><body style="margin:0;background:#fff;font:600 13px system-ui"><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;padding:10px">${cells}</div>
      <style>figure{margin:0;display:grid;gap:4px}img{width:100%;height:170px;object-fit:contain;background:#eee}figcaption{font:500 12px ui-monospace,monospace}</style></body></html>`);
    await page.waitForTimeout(200);
    const file = path.join(dir, `images-sheet-${String(s / 20 + 1).padStart(2, "0")}.png`);
    await page.screenshot({ path: file, fullPage: true });
    sheets.push(path.relative(root, file));
  }
  return sheets;
}

export async function brief(project, opts = {}) {
  const { p, cfg, root } = project;
  const content = readJson(p.content);
  if (!content) throw new RemakeError("No swap file yet.", "Run `remake slots` first.");
  const file = path.join(p.work, "images.json");
  const prev = readJson(file, { entries: [] });
  const keep = new Map(prev.entries.map((e) => [e.id, e]));
  const slots = content.slots.filter(
    (s) => s.kind === "image" && !SKIP_GROUPS.has(s.group) && (s.shown || s.missing) && s.status !== "applied",
  );
  step(`Measuring ${slots.length} images that still belong to the original`);
  const browser = await launch();
  const page = await (await browser.newContext()).newPage();
  const entries = [];
  try {
    for (const s of slots) {
      const existing = (s.files || []).map((f) => path.join(p.site, f)).filter((f) => fs.existsSync(f));
      const biggest = existing.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
      let look = biggest ? await measure(page, biggest) : null;
      if (!look) look = { w: s.width || 1600, h: s.height || 1000, palette: [], brightness: 50, saturation: 30, kind: "photo" };
      const e = {
        id: s.id,
        file: biggest ? path.relative(p.site, biggest).split(path.sep).join("/") : null,
        width: look.w,
        height: look.h,
        orientation: orientation(look.w, look.h),
        palette: look.palette,
        brightness: look.brightness,
        saturation: look.saturation,
        kind: look.kind,
        alt: s.alt || "",
        section: s.section || "",
        missing: !!s.missing,
        prompt: keep.get(s.id)?.prompt ?? null,
        keywords: keep.get(s.id)?.keywords ?? null,
        result: keep.get(s.id)?.result ?? null,
      };
      e.look = describeLook(e);
      entries.push(e);
    }
    const shown = entries.filter((e) => e.file);
    const sheets = shown.length ? await contactSheets(page, shown, p.work, root) : [];
    writeJson(file, {
      theme: opts.theme || prev.theme || null,
      how:
        "For each entry, write `prompt`: what the NEW brand's picture should show, keeping the original's framing, " +
        "orientation, light and palette (see `look`). Describe a new scene; never copy the original's people, text, logos or " +
        "artwork. Optional `keywords` (3–6 words) guide the free stock search. Then run `remake images --make`.",
      sheets,
      entries,
    });
    say(`  ${entries.length} images to replace (${entries.filter((e) => e.missing).length} missing in the copy).`);
    if (sheets.length) say(`  Look at them: ${sheets.join(", ")}`);
    say("  Next: write a `prompt` for each entry in remake/images.json, then `remake images --make`.");
  } finally {
    await browser.close();
  }
}

// ---------- providers ----------

function findCodex() {
  const candidates = [
    process.env.REMAKE_CODEX,
    "codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

function codexModel(bin) {
  if (process.env.REMAKE_CODEX_MODEL) return process.env.REMAKE_CODEX_MODEL;
  const r = spawnSync(bin, ["debug", "models"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  try {
    const text = r.stdout || "";
    const models = JSON.parse(text.slice(text.indexOf("{"))).models.filter((m) => m.visibility === "list");
    // The image tool does the work; the smallest listed model is enough to drive it.
    const small = models.find((m) => /luna|mini|nano|small/i.test(m.slug));
    return (small || models[models.length - 1])?.slug || null;
  } catch {
    return null;
  }
}

export function providers() {
  const list = [];
  const codex = findCodex();
  if (codex && fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"))) list.push({ name: "codex", bin: codex });
  if (process.env.OPENAI_API_KEY) list.push({ name: "openai" });
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) list.push({ name: "gemini" });
  list.push({ name: "stock" }, { name: "art" });
  return list;
}

const SAFE = "No text, no words, no letters, no numbers, no logos, no watermarks, no signatures.";

function runCodex(bin, model, dir, items) {
  const lines = items.map((e) => {
    const size = e.orientation === "landscape" ? "landscape (1536x1024)" : e.orientation === "portrait" ? "portrait (1024x1536)" : "square (1024x1024)";
    return `- ${e.id}.png, ${size}: ${e.prompt} Look: ${e.look}. ${SAFE}`;
  });
  const prompt =
    `Use your image generation tool to create ${items.length} separate images, one for each line below, at the size given. ` +
    `Save each image in the current folder under the exact file name at the start of its line. Do not create anything else. ` +
    `When done, reply with the file names you saved.\n\n${lines.join("\n")}`;
  // The prompt goes in through stdin ("-"): on Windows codex is a .cmd file, and cmd.exe cuts an argument at its first
  // line break and caps the whole command line at 8,191 characters.
  const args = ["exec", ...(model ? ["-m", model] : []), "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", dir, "-"];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(prompt);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 20 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function openaiImage(e) {
  const size = e.orientation === "landscape" ? "1536x1024" : e.orientation === "portrait" ? "1024x1536" : "1024x1024";
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.REMAKE_OPENAI_IMAGE_MODEL || "gpt-image-1", prompt: `${e.prompt} Look: ${e.look}. ${SAFE}`, size, n: 1 }),
  });
  const j = await res.json();
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error(j?.error?.message || `OpenAI answered ${res.status}`);
  return Buffer.from(b64, "base64");
}

async function geminiImage(e) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const model = process.env.REMAKE_GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: `${e.prompt} Composition: ${e.orientation}. Look: ${e.look}. ${SAFE}` }] }] }),
  });
  const j = await res.json();
  const part = j?.candidates?.[0]?.content?.parts?.find((x) => x.inlineData);
  if (!part) throw new Error(j?.error?.message || `Gemini answered ${res.status}`);
  return Buffer.from(part.inlineData.data, "base64");
}

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function paletteDistance(a, b) {
  if (!a.length || !b.length) return 999;
  let total = 0;
  for (const x of a.slice(0, 3)) {
    const rx = hexToRgb(x);
    total += Math.min(...b.map((y) => {
      const ry = hexToRgb(y);
      return Math.sqrt((rx[0] - ry[0]) ** 2 + (rx[1] - ry[1]) ** 2 + (rx[2] - ry[2]) ** 2);
    }));
  }
  return total / Math.min(3, a.length);
}

// Free stock: Openverse (CC0 and public-domain images, usable commercially, no attribution required).
async function stockImage(page, e, cacheDir) {
  const words = (e.keywords || e.prompt || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(with|that|this|from|into|over|under|their|there|light|photo|image|style|look|palette|editorial|photography|composition)$/.test(w))
    .slice(0, 5)
    .join(" ");
  const aspect = e.orientation === "landscape" ? "wide" : e.orientation === "portrait" ? "tall" : "square";
  const headers = { "user-agent": `Mozilla/5.0 ${UA_SUFFIX}` };
  let results = [];
  try {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(words)}&license=cc0,pdm&aspect_ratio=${aspect}&page_size=12&mature=false`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (res.ok) results = ((await res.json()).results || []).map((r) => ({ id: r.id, thumb: r.thumbnail || r.url, full: r.url, title: r.title, creator: r.creator, license: r.license, page: r.foreign_landing_url, source: "Openverse" }));
  } catch {}
  if (!results.length) {
    // Wikimedia Commons, public domain and CC0 only.
    const api = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent("filetype:bitmap " + words)}&gsrnamespace=6&gsrlimit=40&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=2000&format=json`;
    const res = await fetch(api, { headers, signal: AbortSignal.timeout(30000) });
    const pages = Object.values((await res.json())?.query?.pages || {});
    const want = e.width / e.height;
    results = pages
      .map((pg) => ({ pg, ii: pg.imageinfo?.[0] }))
      .filter(({ ii }) => ii && /^(cc0|public domain|pd\b|pd-)/i.test(ii.extmetadata?.LicenseShortName?.value || ""))
      .filter(({ ii }) => Math.abs(Math.log((ii.width / ii.height) / want)) < 0.45 && ii.width >= 800)
      .map(({ pg, ii }) => ({
        id: String(pg.pageid),
        thumb: ii.thumburl,
        full: ii.thumburl || ii.url,
        title: pg.title.replace(/^File:/, ""),
        creator: (ii.extmetadata?.Artist?.value || "").replace(/<[^>]+>/g, "").trim(),
        license: ii.extmetadata?.LicenseShortName?.value,
        page: ii.descriptionurl,
        source: "Wikimedia Commons",
      }));
  }
  const scored = [];
  for (const r of results.slice(0, 8)) {
    try {
      const t = await fetch(r.thumb, { headers, signal: AbortSignal.timeout(30000) });
      if (!t.ok) continue;
      const tmp = path.join(cacheDir, `thumb-${r.id}.jpg`);
      fs.writeFileSync(tmp, Buffer.from(await t.arrayBuffer()));
      const look = await measure(page, tmp);
      if (look) scored.push({ r, d: paletteDistance(e.palette, look.palette) + Math.abs(look.brightness - e.brightness) });
      await sleep(400);
    } catch {}
  }
  scored.sort((a, b) => a.d - b.d);
  for (const { r } of scored) {
    try {
      const full = await fetch(r.full, { headers, signal: AbortSignal.timeout(60000) });
      if (!full.ok) continue;
      return { buffer: Buffer.from(await full.arrayBuffer()), credit: { source: r.source, title: r.title, creator: r.creator, license: r.license, url: r.page } };
    } catch {}
  }
  throw new Error(`no free stock photo found for "${words}"`);
}

// Generated art in the original's palette: soft fields of colour, grain and shapes. Always available.
async function artImage(page, e) {
  const W = e.orientation === "portrait" ? 1024 : 1536;
  const H = e.orientation === "landscape" ? 1024 : e.orientation === "portrait" ? 1536 : 1024;
  const palette = e.palette.length ? e.palette : ["#1f2a44", "#e8e2d6", "#c75b39", "#6f8f8a", "#11151c"];
  const b64 = await page.evaluate(({ W, H, palette, seed }) => {
    let s = seed;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = palette[0];
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 9; i++) {
      const x = rnd() * W, y = rnd() * H, r = (0.25 + rnd() * 0.6) * Math.max(W, H);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, palette[1 + (i % (palette.length - 1))] + "cc");
      g.addColorStop(1, palette[1 + (i % (palette.length - 1))] + "00");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = palette[palette.length - 1];
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      const y0 = rnd() * H;
      ctx.moveTo(0, y0);
      for (let x = 0; x <= W; x += 24) ctx.lineTo(x, y0 + Math.sin(x / (120 + rnd() * 80) + i) * (20 + rnd() * 40));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const img = ctx.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * 22;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png").split(",")[1];
  }, { W, H, palette, seed: [...e.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) });
  return Buffer.from(b64, "base64");
}

// ---------- making ----------

export async function make(project, opts = {}) {
  const { p } = project;
  const file = path.join(p.work, "images.json");
  const data = readJson(file);
  if (!data) throw new RemakeError("No image brief yet.", "Run `remake images` first.");
  const outDir = ensureDir(path.join(p.work, "mine", "images"));
  const cacheDir = ensureDir(path.join(p.work, ".cache", "images"));
  const credits = readJson(path.join(p.work, "credits.json"), {});
  // Entries that point at one of the user's own pictures (`use`) need no generator.
  for (const e of data.entries) {
    const own = e.use && path.resolve(project.root, e.use);
    if (own && fs.existsSync(own) && (opts.force || !e.result)) {
      const ext = path.extname(own).toLowerCase() || ".jpg";
      const rel = path.join("remake", "mine", "images", `${e.id}${ext}`);
      ensureDir(path.join(project.root, "remake", "mine", "images"));
      fs.copyFileSync(own, path.join(project.root, rel));
      e.result = rel;
      credits[e.id] = { source: "your own picture", file: e.use, made: new Date().toISOString() };
    }
  }
  writeJson(path.join(p.work, "credits.json"), credits);
  writeJson(file, data);
  const todo = data.entries.filter((e) => (opts.force || !e.result || !fs.existsSync(path.join(project.root, e.result))) && (e.prompt || opts.source === "art"));
  const unbriefed = data.entries.filter((e) => !e.prompt && !e.use).length;
  if (unbriefed && opts.source !== "art") warn(`${unbriefed} entries have no prompt yet and are skipped (write them in remake/images.json).`);
  if (!todo.length) return say("Nothing to make: every briefed image already has a result.");
  const available = providers();
  const order = opts.source && opts.source !== "auto" ? available.filter((x) => x.name === opts.source) : available;
  if (!order.length) throw new RemakeError(`Image source "${opts.source}" isn't available here.`, `Available: ${available.map((x) => x.name).join(", ")}.`);
  step(`Making ${todo.length} images (${order.map((x) => x.name).join(" → ")})`);

  const browser = await launch();
  const page = await (await browser.newContext()).newPage();
  const done = (e, buffer, credit) => {
    const rel = path.join("remake", "mine", "images", `${e.id}${buffer[0] === 0x89 ? ".png" : ".jpg"}`);
    fs.writeFileSync(path.join(project.root, rel), buffer);
    e.result = rel;
    credits[e.id] = { ...credit, prompt: e.prompt, made: new Date().toISOString() };
  };
  let left = [...todo];
  try {
    for (const prov of order) {
      if (!left.length) break;
      if (prov.name === "codex") {
        const model = codexModel(prov.bin);
        const batches = [];
        for (let i = 0; i < left.length; i += 4) batches.push(left.slice(i, i + 4));
        const parallel = Number(opts.parallel || 3);
        say(`  Codex on your ChatGPT plan${model ? ` (${model})` : ""}: ${batches.length} batches of up to 4, ${parallel} at a time…`);
        let finished = 0;
        while (batches.length) {
          const wave = batches.splice(0, parallel);
          await Promise.all(
            wave.map(async (items) => {
              const dir = ensureDir(path.join(cacheDir, `codex-${items[0].id}`));
              await runCodex(prov.bin, model, dir, items);
              for (const e of items) {
                const f = path.join(dir, `${e.id}.png`);
                if (fs.existsSync(f) && fs.statSync(f).size > 1000) done(e, fs.readFileSync(f), { source: "Codex image generation (ChatGPT plan)", license: "yours (OpenAI terms: you own the output)" });
              }
              finished += items.length;
              say(`    ${finished}/${left.length}`);
            }),
          );
          writeJson(file, data);
          writeJson(path.join(p.work, "credits.json"), credits);
        }
      } else {
        for (const e of left) {
          try {
            if (prov.name === "openai") done(e, await openaiImage(e), { source: "OpenAI Images API", license: "yours (OpenAI terms)" });
            else if (prov.name === "gemini") done(e, await geminiImage(e), { source: "Google Gemini image model", license: "yours (Google terms)" });
            else if (prov.name === "stock") {
              const r = await stockImage(page, e, cacheDir);
              done(e, r.buffer, r.credit);
            } else if (prov.name === "art") done(e, await artImage(page, e), { source: "Remake generated art (original palette)", license: "yours" });
          } catch (err) {
            if (prov.name !== "art") say(`    ${prov.name}: ${e.id}: ${err.message}`);
          }
        }
      }
      left = left.filter((e) => !e.result || !fs.existsSync(path.join(project.root, e.result)));
      writeJson(file, data);
      writeJson(path.join(p.work, "credits.json"), credits);
    }
  } finally {
    await browser.close();
  }

  // Point each slot's swap at its new image; `remake apply` crops and encodes it into every size.
  const content = readJson(p.content);
  let set = 0;
  for (const e of data.entries) {
    if (!e.result) continue;
    const s = content.slots.find((x) => x.id === e.id);
    if (s && s.status !== "applied") {
      s.swap = path.join(project.root, e.result);
      set++;
    }
  }
  writeJson(p.content, content);
  const madeCount = data.entries.filter((e) => e.result).length;
  ok(`${madeCount} of ${data.entries.length} images ready, ${set} slots set. Credits: remake/credits.json`);
  if (left.length) warn(`${left.length} couldn't be made: ${left.slice(0, 6).map((e) => e.id).join(", ")}${left.length > 6 ? "…" : ""}`);
  say("Next: remake apply");
}
