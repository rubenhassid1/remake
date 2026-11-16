// Freeze time. A living page (intro animations, WebGL noise, random headlines, smooth scroll)
// never looks the same twice, so it can't be compared to the pixel. Remake pauses the page's
// clock before the first script runs, seeds Math.random, then moves time forward itself in
// exact steps. Load the same page twice this way and you get the same frames twice.
import { newContext, networkTracker, scrollMetrics } from "./browser.mjs";
import { attachStore } from "./httpstore.mjs";

// `frozen` adds what only the scoring runs need: videos held on their first frame.
export function initScript(seed, { frozen = false } = {}) {
  return `(() => {
  // Seeded randomness, one stream per place in the code that asks for it. Scripts load in a
  // different order on every visit; per-call-site streams keep each random pick the same anyway.
  const SEED = ${seed >>> 0};
  const streams = new Map();
  const hash = (str) => { let h = 0x811c9dc5 ^ SEED; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
  const site = (line) => line
    .replace(/https?:\\/\\/[^/\\s)]+/g, "")
    .replace(/\\/_ext\\/[^/]+/g, "")
    .replace(/([^/\\s(]*?):(\\d+):\\d+/g, (m, file, ln) => file.split("/").pop() + ":" + ln);
  Math.random = function () {
    let key = "";
    try { key = String(new Error().stack).split("\\n").slice(2, 4).map(site).join("|"); } catch (e) {}
    let s = streams.has(key) ? streams.get(key) : hash(key);
    s = (s + 0x6d2b79f5) | 0;
    streams.set(key, s);
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // crypto.getRandomValues and randomUUID get the same treatment (games, generative art, ids).
  if (${frozen} && self.crypto) {
    const fill = (arr) => {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      return arr;
    };
    try { Object.defineProperty(self.crypto, "getRandomValues", { value: fill, configurable: true }); } catch (e) {}
    try {
      Object.defineProperty(self.crypto, "randomUUID", { configurable: true, value: () => {
        const b = fill(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
        const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
        return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
      } });
    } catch (e) {}
  }
  // element.animate() runs on the browser's real clock, not the page's. Hold each such animation
  // and move it forward from the frozen clock instead, so a game or loader steps the same way twice.
  if (${frozen} && self.Element && Element.prototype.animate && self.Animation) {
    const AP = Animation.prototype;
    const nPlay = AP.play, nPause = AP.pause, nFinish = AP.finish, nCancel = AP.cancel;
    const ct = Object.getOwnPropertyDescriptor(AP, "currentTime");
    const driven = new Set();
    let ticking = false;
    const end = (a) => { try { return a.effect.getComputedTiming().endTime; } catch (e) { return Infinity; } };
    const tick = () => {
      for (const a of driven) {
        const s = a.__remake;
        if (s.held) continue;
        const rate = a.playbackRate || 1;
        const t = s.base + (performance.now() - s.since) * rate;
        const e = end(a);
        if ((rate > 0 && Number.isFinite(e) && t >= e) || (rate < 0 && t <= 0)) { driven.delete(a); nFinish.call(a); }
        else ct.set.call(a, t);
      }
      if (driven.size) requestAnimationFrame(tick); else ticking = false;
    };
    const go = () => { if (!ticking) { ticking = true; requestAnimationFrame(tick); } };
    const drive = (a) => {
      a.__remake = { base: ct.get.call(a) || 0, since: performance.now(), held: false };
      nPause.call(a);
      driven.add(a);
      go();
      a.play = function () {
        const s = this.__remake;
        if (!driven.has(this)) {
          const cur = ct.get.call(this), e = end(this);
          s.base = cur == null || (Number.isFinite(e) && cur >= e) ? 0 : cur;
          driven.add(this);
          nPause.call(this);
        } else if (s.held) s.base = ct.get.call(this) ?? s.base;
        s.since = performance.now();
        s.held = false;
        go();
      };
      a.pause = function () {
        const s = this.__remake;
        if (driven.has(this) && !s.held) { s.base = ct.get.call(this) ?? s.base; s.held = true; }
        nPause.call(this);
      };
      a.cancel = function () { driven.delete(this); nCancel.call(this); };
      a.finish = function () { driven.delete(this); nFinish.call(this); };
      Object.defineProperty(a, "currentTime", {
        configurable: true,
        get() { return ct.get.call(this); },
        set(v) { ct.set.call(this, v); this.__remake.base = v ?? 0; this.__remake.since = performance.now(); },
      });
    };
    const nAnimate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { const a = nAnimate.apply(this, args); try { drive(a); } catch (e) {} return a; };
  }
  const eager = (n) => { if (n.tagName === "IMG" && n.loading === "lazy") n.loading = "eager"; };
  const hold = (v) => { if (${frozen} && !v.__remakeHeld) { v.__remakeHeld = true; v.autoplay = false; v.removeAttribute("autoplay"); v.addEventListener("play", () => v.pause()); } };
  if (${frozen}) {
    // Video runs on the real clock, not the page's. Hold every video on its first frame.
    HTMLMediaElement.prototype.play = function () { hold(this); return Promise.resolve(); };
  }
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) {
    eager(n); if (n.tagName === "VIDEO" || n.tagName === "AUDIO") hold(n);
    if (n.querySelectorAll) { n.querySelectorAll('img[loading="lazy"]').forEach(eager); n.querySelectorAll("video, audio").forEach(hold); }
  } }).observe(document, { childList: true, subtree: true });
  try { navigator.sendBeacon = () => true; } catch (e) {}
})();`;
}

// Open a page with time stopped at a fixed date. Nothing time-based runs until advance().
export async function openFrozen(browser, url, vp, cfg, { store, archive } = {}) {
  const context = await newContext(browser, vp);
  await context.addInitScript(initScript(cfg.seed, { frozen: true }));
  await context.clock.install({ time: cfg.epoch });
  await context.clock.pauseAt(cfg.epoch + 1000);
  if (store) await attachStore(context, store, { archive });
  const page = await context.newPage();
  const net = networkTracker(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await net.idle(8000);
  await Promise.race([
    page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => {}),
    new Promise((r) => setTimeout(r, 10000)),
  ]);
  await page.mouse.move(vp.width / 2, vp.height / 2);
  return { context, page, net, errors };
}

// Move the page's clock forward in small steps, letting the network catch up between steps.
export async function advance(page, net, ms, stepMs = 100) {
  for (let t = 0; t < ms; t += stepMs) {
    await page.clock.runFor(Math.min(stepMs, ms - t));
    if (net.count) await net.idle(3000);
  }
}

// Videos keep their own real-time clock: park every one of them on its first frame.
// (Page timers are frozen, so all waiting happens out here in real time.)
export async function parkMedia(page) {
  const parked = await page
    .evaluate(() => {
      let n = 0;
      for (const v of document.querySelectorAll("video, audio")) {
        try {
          v.pause();
          if (v.readyState >= 1 && v.currentTime !== 0) v.currentTime = 0;
          n++;
        } catch (e) {}
      }
      return n;
    })
    .catch(() => 0);
  if (!parked) return;
  // Wait (real time) until every video with a source has its first frame, then let one
  // frame of page time pass so WebGL scenes that draw the video pick it up.
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const busy = await page
      .evaluate(() => [...document.querySelectorAll("video")].some((v) => v.seeking || ((v.currentSrc || v.srcObject) && v.readyState < 2 && v.networkState !== 3)))
      .catch(() => false);
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  await page.clock.runFor(34).catch(() => {});
}

export async function frame(page) {
  await parkMedia(page);
  try {
    return await page.screenshot({ animations: "disabled", caret: "hide", scale: "css", timeout: 45000 });
  } catch {
    // A stalled frame (slow GPU emulation, a late file): let one page frame pass and try once more.
    await page.clock.runFor(16).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    return page.screenshot({ animations: "disabled", caret: "hide", scale: "css", timeout: 90000 });
  }
}

// Scroll with the wheel, the way a visitor does, so smooth-scroll libraries move too.
export async function wheelBy(page, net, dy, { tick = 16, chunk = 100 } = {}) {
  const start = await page.evaluate(() => scrollY).catch(() => null);
  let left = dy;
  while (Math.abs(left) > 0) {
    const d = Math.sign(left) * Math.min(chunk, Math.abs(left));
    await page.mouse.wheel(0, d);
    left -= d;
    await page.clock.runFor(tick);
    if (net.count) await net.idle(1500);
  }
  // Chrome sometimes applies the last wheel step late. Wait until the page has reached
  // the target (or the bottom) so every load is captured at the same position.
  if (start === null) return;
  for (let k = 0; k < 40; k++) {
    const { y, max } = await page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight })).catch(() => ({ y: 0, max: 0 }));
    if (Math.abs(y - Math.max(0, Math.min(start + dy, max))) < 2) break;
    await page.clock.runFor(tick).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
  }
}

// The standard pass: settle, then one frame per screen-height of scroll until the bottom.
export async function screens(page, net, cfg, vp, { targets } = {}) {
  await advance(page, net, cfg.settleMs);
  const m0 = await scrollMetrics(page);
  const height = m0.height;
  const list = targets || [];
  if (!targets) {
    for (let y = 0; ; y += vp.height) {
      const t = Math.min(y, Math.max(0, height - vp.height));
      if (list.length && t === list[list.length - 1]) break;
      list.push(t);
      if (t >= height - vp.height) break;
      if (list.length >= 40) break;
    }
  }
  const frames = [];
  let at = 0;
  for (const target of list) {
    if (target !== at) {
      await wheelBy(page, net, target - at);
      at = target;
      await advance(page, net, cfg.scrollSettleMs);
    }
    const m = await scrollMetrics(page);
    frames.push({ y: target, actualY: m.top, png: await frame(page) });
  }
  return { height, targets: list, frames };
}

// The movie: small scroll steps with little settling, to catch animations mid-flight.
export async function film(page, net, cfg, vp) {
  await advance(page, net, cfg.settleMs);
  const frames = [];
  for (let i = 0; i < cfg.motionFrames; i++) {
    frames.push({ i, png: await frame(page) });
    await wheelBy(page, net, Math.round(vp.height / 6));
    await advance(page, net, 120, 40);
  }
  return { frames };
}
