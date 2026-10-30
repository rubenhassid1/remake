// One Chromium setup for every visit, so the original and the remake render the same way.
import { chromium } from "playwright";
import { RemakeError, UA_SUFFIX } from "./util.mjs";

const ARGS = [
  // WebGL in headless Chromium without a GPU: software rendering, same output every run.
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--hide-scrollbars",
  "--disable-smooth-scrolling",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--autoplay-policy=no-user-gesture-required",
];

export async function launch() {
  try {
    return await chromium.launch({ args: ARGS });
  } catch (e) {
    // Playwright's own Chromium build sometimes won't run on this OS (e.g. an old macOS it dropped
    // support for). Fall back to the system's installed Chrome, if there is one, before giving up.
    try {
      return await chromium.launch({ args: ARGS, channel: "chrome" });
    } catch {}
    throw new RemakeError(
      "Chromium for Playwright isn't installed.",
      "Run `remake doctor --fix` (it runs `npx playwright install chromium`), or install Google Chrome.",
    );
  }
}

let baseUA = null;
async function userAgent(browser, mobile) {
  if (!baseUA) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    baseUA = await page.evaluate(() => navigator.userAgent);
    await ctx.close();
  }
  // Honest identity: the normal Chromium string plus who is visiting and why.
  const ua = mobile
    ? baseUA.replace(/\(([^)]*)\)/, "(Linux; Android 14; Pixel 8)").replace("Safari/", "Mobile Safari/")
    : baseUA;
  return `${ua} ${UA_SUFFIX}`;
}

export async function newContext(browser, vp) {
  return browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: !!vp.isMobile,
    hasTouch: !!vp.isMobile,
    userAgent: await userAgent(browser, vp.isMobile),
    serviceWorkers: "block",
    locale: "en-US",
    timezoneId: "Europe/Amsterdam",
    colorScheme: "light",
    reducedMotion: "no-preference",
    ignoreHTTPSErrors: true,
  });
}

// Tracks in-flight requests so virtual time only moves once the network is quiet.
export function networkTracker(page) {
  const pending = new Set();
  const quiet = (req) => {
    const t = req.resourceType();
    return t === "media" || t === "websocket" || t === "eventsource" || t === "ping";
  };
  page.on("request", (r) => !quiet(r) && pending.add(r));
  page.on("requestfinished", (r) => pending.delete(r));
  page.on("requestfailed", (r) => pending.delete(r));
  return {
    get count() {
      return pending.size;
    },
    async idle(maxMs = 4000) {
      const until = Date.now() + maxMs;
      while (pending.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      return pending.size === 0;
    },
  };
}

// The element that scrolls the page: the document, or a wrapper used by smooth-scroll libraries.
export async function scrollMetrics(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    const vh = window.innerHeight;
    let best = { el: doc, height: doc.scrollHeight, top: doc.scrollTop };
    if (doc.scrollHeight <= vh + 2) {
      for (const el of document.querySelectorAll("body *")) {
        if (el.scrollHeight <= el.clientHeight + 2 || el.clientHeight < vh * 0.6) continue;
        const oy = getComputedStyle(el).overflowY;
        if (!/(auto|scroll|overlay)/.test(oy)) continue;
        if (el.scrollHeight > best.height) best = { el, height: el.scrollHeight, top: el.scrollTop };
      }
    }
    // Smooth-scroll libraries often translate a content wrapper instead of scrolling.
    const wrapperHeight = Math.max(
      ...[...document.querySelectorAll("[data-scroll-container], .js-scroll-content, .smooth-content, [data-lenis-content]")].map(
        (e) => e.getBoundingClientRect().height,
      ),
      0,
    );
    const height = Math.max(best.height, Math.round(wrapperHeight));
    const top = best.el === doc ? window.scrollY : best.top;
    return { height: Math.round(height), top: Math.round(top), viewport: vh };
  });
}
