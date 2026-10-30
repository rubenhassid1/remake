// Doctor: is everything installed and signed in? With --fix, installs what can be installed.
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { say, ok, warn, step } from "./util.mjs";
import { ENGINE_ROOT } from "./project.mjs";

const has = (cmd, args = ["--version"]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
};

export async function doctor({ fix = false } = {}) {
  step("Checking your machine");
  const todo = [];
  const node = Number(process.versions.node.split(".")[0]);
  node >= 20 ? ok(`Node ${process.versions.node}`) : todo.push(["Node 20 or newer", "Install it from https://nodejs.org (the LTS button)."]);

  has("git").ok ? ok("git") : todo.push(["git", "macOS: run `xcode-select --install`. Windows: https://git-scm.com"]);

  let gh = has("gh");
  if (!gh.ok && fix && has("brew").ok) {
    say("  installing GitHub CLI…");
    spawnSync("brew", ["install", "gh"], { stdio: "inherit" });
    gh = has("gh");
  }
  if (!gh.ok) todo.push(["GitHub CLI", "macOS: `brew install gh`. Others: https://cli.github.com"]);
  else if (!has("gh", ["auth", "status"]).ok) todo.push(["GitHub sign-in", "Run `gh auth login --web` and click through once in your browser."]);
  else ok("GitHub CLI, signed in");

  // Either host's CLI will do for `remake ship --host vercel|cloudflare`; only install one (vercel, by
  // default) if `--fix` is on and neither is already present — never install a second one you don't need.
  let vercel = has("vercel");
  let wrangler = has("wrangler");
  if (!vercel.ok && !wrangler.ok && fix) {
    say("  installing Vercel CLI…");
    spawnSync("npm", ["install", "-g", "vercel"], { stdio: "inherit" });
    vercel = has("vercel");
  }
  if (!vercel.ok && !wrangler.ok) {
    todo.push(["Vercel CLI or Wrangler", "Run `npm install -g vercel` or `npm install -g wrangler`, whichever you deploy with."]);
  } else if (vercel.ok) {
    const who = has("vercel", ["whoami"]);
    who.ok ? ok(`Vercel CLI, signed in as ${who.out.split("\n").pop()}`) : todo.push(["Vercel sign-in", "Run `vercel login` and click through once in your browser."]);
    if (wrangler.ok) {
      const ww = has("wrangler", ["whoami"]);
      if (ww.ok && !/not authenticated|not logged in/i.test(ww.out)) ok(`Wrangler, signed in (${ww.out.trim().split("\n").filter(Boolean).pop()})`);
    }
  } else {
    const ww = has("wrangler", ["whoami"]);
    ww.ok && !/not authenticated|not logged in/i.test(ww.out)
      ? ok(`Wrangler, signed in (${ww.out.trim().split("\n").filter(Boolean).pop()})`)
      : todo.push(["Cloudflare sign-in", "Run `wrangler login` and click through once in your browser."]);
  }

  let browserOk = false;
  let viaChrome = false;
  const tryLaunch = async () => {
    try {
      const b = await chromium.launch();
      await b.close();
      return true;
    } catch {}
    try {
      const b = await chromium.launch({ channel: "chrome" });
      await b.close();
      viaChrome = true;
      return true;
    } catch {}
    return false;
  };
  browserOk = await tryLaunch();
  if (!browserOk && fix) {
    say("  downloading Chromium for Playwright (about 150 MB, once)…");
    spawnSync("npx", ["playwright", "install", "chromium"], { stdio: "inherit", cwd: ENGINE_ROOT });
    browserOk = await tryLaunch();
  }
  if (browserOk) ok(viaChrome ? "Chromium for Playwright (via installed Google Chrome; Playwright's own build doesn't run on this OS)" : "Chromium for Playwright");
  else todo.push(["Chromium for Playwright", "Run `remake doctor --fix`, or install Google Chrome if that fails."]);

  if (!todo.length) {
    say("\nREADY: everything Remake needs is installed and signed in.");
    return true;
  }
  say("\nNOT READY:");
  for (const [what, how] of todo) say(`  - ${what}: ${how}`);
  if (!fix) say("\nRun `remake doctor --fix` to install what can be installed automatically.");
  return false;
}
