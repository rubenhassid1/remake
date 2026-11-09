// Score: the original and the remake, frozen at the same instants, compared pixel by pixel.
// The original is loaded twice from the recording; whatever still differs between those two loads
// is noise (a live feed, a timestamp) and is left out of the score, in plain view.
import fs from "node:fs";
import path from "node:path";
import { launch } from "./browser.mjs";
import { HttpStore } from "./httpstore.mjs";
import { openFrozen, screens, film } from "./freeze.mjs";
import { startServer } from "./serve.mjs";
import { decode, differMask, dilate, maskToPng, pngToMask, compare, diffImage, strip } from "./diff.mjs";
import { pageUrl } from "./project.mjs";
import { archiveFor } from "./capture.mjs";
import { RemakeError, say, ok, warn, step, ensureDir, readJson, writeJson, writeFile, table } from "./util.mjs";

export const pageId = (pagePath) =>
  (pagePath.split("?")[0].replace(/\/index\.html$/, "").replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-") || "home").toLowerCase();

// The original always loads at its own address; in archive mode its files come from the Internet Archive.
export function originalUrl(cfg, pagePath) {
  return pageUrl(cfg, pagePath);
}

async function run(browser, url, vp, cfg, { store, targets, motion }) {
  const { context, page, net, errors } = await openFrozen(browser, url, vp, cfg, { store, archive: store ? archiveFor(cfg) : null });
  try {
    const out = motion ? await film(page, net, cfg, vp) : await screens(page, net, cfg, vp, { targets });
    return { ...out, errors };
  } finally {
    await context.close();
  }
}

async function originalFrames(browser, cfg, p, store, pagePath, vpName, vp, { fresh, motion }) {
  const dir = ensureDir(path.join(p.original, pageId(pagePath), motion ? `${vpName}-motion` : vpName));
  const metaFile = path.join(dir, "meta.json");
  let meta = readJson(metaFile);
  if (meta && !fresh) return { dir, meta };
  const url = originalUrl(cfg, pagePath);
  say(`  recording the original ${motion ? "in motion" : "screens"} at ${vp.width}×${vp.height} (twice, to find its moving parts)…`);
  const a = await run(browser, url, vp, cfg, { store, motion });
  const b = await run(browser, url, vp, cfg, { store, motion, targets: a.targets });
  meta = { url, height: a.height || 0, targets: a.targets || null, frames: a.frames.length, at: new Date().toISOString(), noise: [] };
  a.frames.forEach((f, i) => {
    const n = String(i).padStart(2, "0");
    fs.writeFileSync(path.join(dir, `${n}.png`), f.png);
    const A = decode(f.png);
    const B = b.frames[i] ? decode(b.frames[i].png) : A;
    const noise = dilate(differMask(A, B), A.width, A.height, 3);
    fs.writeFileSync(path.join(dir, `${n}.noise.png`), maskToPng(noise, A.width, A.height));
    meta.noise.push(Math.round((1000 * noise.reduce((s, v) => s + v, 0)) / noise.length) / 10);
  });
  writeJson(metaFile, meta);
  return { dir, meta };
}

export async function score(project, opts = {}) {
  const { cfg, p } = project;
  if (!cfg.capturedAt) throw new RemakeError("Nothing captured yet.", "Run `remake capture` first.");
  const store = new HttpStore(p.cache);
  const server = await startServer(p.site, { missingLog: p.missing });
  const browser = await launch();
  const prev = readJson(p.score, {}) || {};
  const result = { at: new Date().toISOString(), thresholds: cfg.thresholds, local: server.url, pages: prev.pages || {}, motion: prev.motion || null };
  const onlyPage = opts.page ? [opts.page] : cfg.pages;
  const onlyVp = opts.viewport ? [opts.viewport] : Object.keys(cfg.viewports);
  ensureDir(p.scoreDir);
  try {
    for (const pagePath of onlyPage) {
      const id = pageId(pagePath);
      result.pages[id] = result.pages[id] || { path: pagePath };
      for (const vpName of onlyVp) {
        const vp = cfg.viewports[vpName];
        step(`${pagePath} · ${vpName} ${vp.width}×${vp.height}`);
        const { dir, meta } = await originalFrames(browser, cfg, p, store, pagePath, vpName, vp, { fresh: opts.fresh });
        const remake = await run(browser, server.url + pagePath, vp, cfg, { targets: meta.targets });
        const screensOut = [];
        for (let i = 0; i < meta.frames; i++) {
          const n = String(i).padStart(2, "0");
          const A = decode(fs.readFileSync(path.join(dir, `${n}.png`)));
          const noise = pngToMask(fs.readFileSync(path.join(dir, `${n}.noise.png`)));
          const frame = remake.frames[i];
          if (!frame) {
            screensOut.push({ i, y: meta.targets?.[i], score: 0, note: "remake is shorter: this screen doesn't exist" });
            continue;
          }
          const B = decode(frame.png);
          const c = compare(A, B, noise);
          const label = String(i + 1).padStart(2, "0"); // same number as "screen N" in the score
          const file = path.join(p.scoreDir, `${id}-${vpName}-${label}.png`);
          fs.writeFileSync(file, strip(A, B, diffImage(B, c.diff, noise)));
          fs.writeFileSync(path.join(p.scoreDir, `${id}-${vpName}-${label}.remake.png`), frame.png);
          screensOut.push({
            i,
            y: meta.targets?.[i],
            score: Math.round(c.score * 100) / 100,
            noise: Math.round(c.maskedPct * 10) / 10,
            diff: path.relative(project.root, file),
          });
        }
        const lowest = Math.min(...screensOut.map((s) => s.score));
        result.pages[id][vpName] = {
          screens: screensOut,
          lowest,
          average: Math.round((100 * screensOut.reduce((s, x) => s + x.score, 0)) / screensOut.length) / 100,
          height: { original: meta.height, remake: remake.height },
          errors: remake.errors.slice(0, 10),
        };
        ok(`lowest ${lowest.toFixed(2)}% over ${screensOut.length} screens · height ${meta.height} vs ${remake.height}`);
        if (remake.errors.length) warn(`${remake.errors.length} script errors in the remake, first: ${remake.errors[0].slice(0, 140)}`);
      }
    }
    if (!opts.noMotion && (!opts.viewport || opts.viewport === "desktop") && (!opts.page || opts.page === cfg.pages[0])) {
      const vp = cfg.viewports.desktop;
      step("Motion · the first page, scrolling, frame by frame");
      const { dir, meta } = await originalFrames(browser, cfg, p, store, cfg.pages[0], "desktop", vp, { fresh: opts.fresh, motion: true });
      const remake = await run(browser, server.url + cfg.pages[0], vp, cfg, { motion: true });
      const frames = [];
      for (let i = 0; i < meta.frames; i++) {
        const n = String(i).padStart(2, "0");
        const A = decode(fs.readFileSync(path.join(dir, `${n}.png`)));
        const noise = pngToMask(fs.readFileSync(path.join(dir, `${n}.noise.png`)));
        if (!remake.frames[i]) break;
        const B = decode(remake.frames[i].png);
        const c = compare(A, B, noise);
        if (i % 4 === 0 || c.score < cfg.thresholds.motion) {
          fs.writeFileSync(path.join(p.scoreDir, `motion-${String(i + 1).padStart(2, "0")}.png`), strip(A, B, diffImage(B, c.diff, noise)));
        }
        frames.push({ i, score: Math.round(c.score * 100) / 100, noise: Math.round(c.maskedPct * 10) / 10, considered: c.considered, unscorable: c.unscorable });
      }
      result.motion = { frames, lowest: Math.min(...frames.map((f) => f.score)) };
      ok(`lowest ${result.motion.lowest.toFixed(2)}% over ${frames.length} frames`);
      const unscorable = frames.filter((f) => f.unscorable);
      if (unscorable.length) warn(`${unscorable.length} motion frames have no stable pixels; retry with \`remake score --fresh\` before judging motion.`);
    }
    store.save();
  } finally {
    await browser.close();
    await server.close();
  }
  result.pass = verdict(result, cfg).pass;
  writeJson(p.score, result);
  printScore(result, cfg);
  return result;
}

export function verdict(result, cfg) {
  const t = cfg.thresholds;
  const failing = [];
  for (const [id, page] of Object.entries(result.pages || {})) {
    for (const vpName of Object.keys(cfg.viewports)) {
      const v = page[vpName];
      if (!v) {
        failing.push(`${id} ${vpName}: not scored yet`);
        continue;
      }
      for (const s of v.screens) if (s.score < t.screen) failing.push(`${id} ${vpName} screen ${s.i + 1}: ${s.score}%`);
      if (Math.abs((v.height.original || 0) - (v.height.remake || 0)) > 4) {
        failing.push(`${id} ${vpName}: page height ${v.height.remake}px, original ${v.height.original}px`);
      }
    }
  }
  if (result.motion) for (const f of result.motion.frames) {
    if (f.unscorable) failing.push(`motion frame ${f.i + 1}: no stable pixels (retry with remake score --fresh)`);
    else if (f.score < t.motion) failing.push(`motion frame ${f.i + 1}: ${f.score}%`);
  }
  if (!result.motion) failing.push("motion: not scored yet");
  return { pass: failing.length === 0, failing };
}

export function printScore(result, cfg) {
  const rows = [["Page", "Viewport", "Screens", "Lowest", "Average", "Height (original → remake)", "Noise left out"]];
  for (const [id, page] of Object.entries(result.pages)) {
    for (const vpName of Object.keys(cfg.viewports)) {
      const v = page[vpName];
      if (!v) continue;
      const noise = v.screens.reduce((s, x) => s + (x.noise || 0), 0) / v.screens.length;
      rows.push([id, vpName, v.screens.length, `${v.lowest.toFixed(2)}%`, `${v.average.toFixed(2)}%`, `${v.height.original} → ${v.height.remake}`, `${noise.toFixed(1)}%`]);
    }
  }
  if (result.motion) {
    const noise = result.motion.frames.reduce((s, x) => s + (x.noise || 0), 0) / result.motion.frames.length;
    const scorable = result.motion.frames.filter((f) => !f.unscorable);
    rows.push(["motion", "desktop", `${scorable.length}/${result.motion.frames.length} scorable`, `${result.motion.lowest.toFixed(2)}%`, "", "", `${noise.toFixed(1)}%`]);
  }
  say("\n" + table(rows));
  const v = verdict(result, cfg);
  say(`\nPass mark: every screen ≥ ${cfg.thresholds.screen}%, every motion frame ≥ ${cfg.thresholds.motion}%, page heights within 4 px.`);
  if (v.pass) say("SCORE: PASS");
  else {
    say(`SCORE: NOT YET (${v.failing.length} to fix)`);
    for (const f of v.failing.slice(0, 12)) say(`  - ${f}`);
    say("Diff images (original | remake | red = different, blue = noise left out): remake/score/");
  }
}
