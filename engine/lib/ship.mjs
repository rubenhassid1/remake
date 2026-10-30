// Ship: a private GitHub repo and a live site (Vercel or Cloudflare Pages) behind a passcode, then check the gate works.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { copyTemplates, TEMPLATES } from "./project.mjs";
import { MOVED_IMMUTABLE } from "./serve.mjs";
import { RemakeError, say, ok, warn, step, readJson, writeJson, walk } from "./util.mjs";

export function sh(cmd, args, { cwd, input, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.error) {
    if (allowFail) return { ok: false, out: r.error.message, code: -1 };
    throw new RemakeError(`${cmd} isn't installed.`, "Run `remake doctor --fix`.");
  }
  if (r.status !== 0 && !allowFail) throw new RemakeError(`${cmd} ${args.join(" ")} failed:\n${out.trim().slice(-1500)}`);
  return { ok: r.status === 0, out, stdout: r.stdout || "", code: r.status };
}

// The team the Vercel CLI is switched to (marked ✔ in `vercel teams ls`), so link never stops to ask.
function currentVercelScope() {
  const r = sh("vercel", ["teams", "ls"], { allowFail: true });
  if (!r.ok) return null;
  const lines = r.out.split("\n");
  const marked = lines.find((l) => l.includes("✔"));
  if (marked) return marked.replace("✔", "").trim().split(/\s+/)[0];
  const head = lines.findIndex((l) => /^\s*id\s+/i.test(l));
  const teams = lines.slice(head + 1).map((l) => l.trim().split(/\s+/)[0]).filter((t) => t && /^[a-z0-9-]+$/.test(t));
  return teams.length === 1 ? teams[0] : null;
}

// Vercel won't deploy a folder at _next/static/immutable (it fails with "Unexpected error"). Move it
// aside and add a rewrite, so the page still asks for the same addresses.
function moveReserved(root, site) {
  const from = path.join(site, "_next", "static", "immutable");
  const to = path.join(site, "_next", "static", MOVED_IMMUTABLE);
  if (!fs.existsSync(from) && !fs.existsSync(to)) return;
  if (fs.existsSync(from)) {
    if (fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
    else fs.renameSync(from, to);
    fs.rmSync(from, { recursive: true, force: true });
  }
  const file = path.join(root, "vercel.json");
  const vj = readJson(file, {}) || {};
  const rule = { source: "/_next/static/immutable/:path*", destination: `/_next/static/${MOVED_IMMUTABLE}/:path*` };
  vj.rewrites = (vj.rewrites || []).filter((r) => r.source !== rule.source).concat(rule);
  writeJson(file, vj);
  ok(`moved _next/static/immutable to _next/static/${MOVED_IMMUTABLE} (Vercel keeps that folder for itself), same addresses`);
}

// Cloudflare Pages Functions live in a `functions/` folder at the project root (sibling to the
// `site/` output, same spot `middleware.js` sits in for Vercel). Copied fresh every ship so a patch
// to the gate lands even on a project started before this host existed.
function installCloudflareMiddleware(root) {
  const dir = path.join(root, "functions");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(TEMPLATES, "cloudflare", "_middleware.js"), path.join(dir, "_middleware.js"));
}

const CF_FILE_LIMIT = 25 * 1024 * 1024; // Cloudflare Pages' hard per-file cap

// Cloudflare Pages refuses any single file over 25 MiB (remakes routinely capture bigger videos
// than that). Move oversized files out of the deploy for a moment and 302 them to the URL they
// were captured from (remake/ledger.json); restore everything right after, win or lose, so
// `site/` itself stays the full, faithful capture for score/serve/Vercel.
function withCloudflareSizeLimit(root, p, cfg, fn) {
  const big = walk(p.site, (f) => fs.statSync(f).size > CF_FILE_LIMIT);
  if (!big.length) return fn();

  const ledger = readJson(p.ledger, []) || [];
  const originals = new Map(ledger.filter((e) => e.local && e.url).map((e) => [e.local, e.url]));
  const tmp = path.join(root, ".cloudflare-oversized");
  const redirectsFile = path.join(p.site, "_redirects");
  const hadRedirects = fs.existsSync(redirectsFile);
  const prevRedirects = hadRedirects ? fs.readFileSync(redirectsFile, "utf8") : "";
  const moved = [];
  const lines = [];
  for (const file of big) {
    const webPath = "/" + path.relative(p.site, file).split(path.sep).join("/");
    const mib = (fs.statSync(file).size / (1024 * 1024)).toFixed(0);
    const originalUrl = originals.get(webPath) || new URL(webPath, cfg.origin).href;
    const backup = path.join(tmp, webPath);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(file, backup);
    moved.push({ from: backup, to: file });
    lines.push(`${webPath}  ${originalUrl}  302`);
    warn(`${webPath} is ${mib} MiB, over Cloudflare Pages' 25 MiB file limit; it'll redirect to the original instead of being served from your copy`);
  }
  fs.writeFileSync(redirectsFile, (hadRedirects ? prevRedirects + "\n" : "") + lines.join("\n") + "\n");
  try {
    return fn();
  } finally {
    for (const { from, to } of moved) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (hadRedirects) fs.writeFileSync(redirectsFile, prevRedirects);
    else fs.rmSync(redirectsFile, { force: true });
  }
}

function makePasscode(name) {
  const word = name.replace(/[^a-z]/gi, "").toUpperCase().slice(0, 8) || "REMAKE";
  return `${word}-${crypto.randomBytes(6).toString("base64url")}`;
}

export async function verifyGate(url, passcode, pagePath = "/") {
  const res = { url, gate: false, unlock: false, page: false, noindex: false, checkpoint: false };
  try {
    const a = await fetch(url, { redirect: "manual" });
    const body = await a.text();
    if (a.status === 403 && /Vercel Security Checkpoint/i.test(body)) {
      res.checkpoint = true;
      return res;
    }
    res.gate = a.status === 401 && body.includes("data-remake-gate");
    res.noindex = /noindex/i.test(a.headers.get("x-robots-tag") || "");
    const form = new URLSearchParams({ passcode, next: "/" });
    const b = await fetch(new URL("/_remake/gate", url), {
      method: "POST",
      body: form,
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const cookie = (b.headers.get("set-cookie") || "").split(";")[0];
    res.unlock = b.status === 303 && cookie.startsWith("remake_pass=");
    if (res.unlock) {
      const c = await fetch(new URL(pagePath, url), { headers: { cookie }, redirect: "manual" });
      const html = await c.text();
      res.page = c.status === 200 && !html.includes("data-remake-gate");
    }
  } catch (e) {
    res.error = e.message;
  }
  return res;
}

export async function ship(project, opts = {}) {
  const { cfg, p, root } = project;
  const score = readJson(p.score);
  if (!score) warn("No score yet: shipping anyway, but the report won't pass until `remake score` passes.");
  else if (!score.pass) warn("The score doesn't pass yet. Shipping anyway so you can look at it; the report will say what's left.");
  copyTemplates(root, { name: cfg.name, url: cfg.url });
  // A remade page that isn't the home page (/en, /about/): send the site's root to it.
  const first = cfg.pages?.[0] || "/";
  if (first !== "/" && !fs.existsSync(path.join(p.site, "index.html"))) {
    fs.writeFileSync(path.join(p.site, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><meta http-equiv="refresh" content="0;url=${first}"><link rel="canonical" href="${first}"><title>Redirecting</title><a href="${first}">Continue</a>`);
  }
  const prev = readJson(p.ship, {}) || {};
  const host = opts.host || prev.host || "vercel";
  if (host !== "vercel" && host !== "cloudflare") throw new RemakeError(`Unknown --host "${host}".`, "Use --host vercel or --host cloudflare.");
  const name = opts.name || prev.name || `remake-${cfg.name}`.slice(0, 90);
  const passcode = opts.passcode || prev.passcode || makePasscode(cfg.name);

  if (host === "cloudflare") {
    installCloudflareMiddleware(root);
  } else {
    moveReserved(root, p.site);
  }

  step(`Checking you're signed in to GitHub and ${host === "cloudflare" ? "Cloudflare" : "Vercel"}`);
  if (!sh("gh", ["auth", "status"], { allowFail: true }).ok) {
    throw new RemakeError("GitHub CLI isn't signed in.", "Run `gh auth login --web` and click through once in your browser.");
  }
  if (host === "cloudflare") {
    const who = sh("wrangler", ["whoami"], { allowFail: true });
    if (!who.ok || /not authenticated|not logged in/i.test(who.out)) {
      throw new RemakeError("Wrangler (Cloudflare's CLI) isn't signed in.", "Run `wrangler login` and click through once in your browser.");
    }
    ok(`GitHub and Cloudflare (${who.out.trim().split("\n").filter(Boolean).pop()})`);
  } else {
    const who = sh("vercel", ["whoami"], { allowFail: true });
    if (!who.ok) throw new RemakeError("Vercel CLI isn't signed in.", "Run `vercel login` and click through once in your browser.");
    ok(`GitHub and Vercel (${who.stdout.trim().split("\n").pop()})`);
  }

  step("Saving to a private GitHub repo");
  if (!fs.existsSync(path.join(root, ".git"))) sh("git", ["init", "-b", "main"], { cwd: root });
  // A commit needs an author. Without one set on this machine, use the GitHub account's.
  if (!sh("git", ["config", "user.email"], { cwd: root, allowFail: true }).stdout.trim()) {
    const me = JSON.parse(sh("gh", ["api", "user"], { allowFail: true }).stdout || "{}");
    const email = me.email || (me.id && me.login ? `${me.id}+${me.login}@users.noreply.github.com` : "remake@users.noreply.github.com");
    sh("git", ["config", "user.email", email], { cwd: root });
    sh("git", ["config", "user.name", me.name || me.login || "Remake"], { cwd: root });
  }
  sh("git", ["add", "-A"], { cwd: root });
  const dirty = !sh("git", ["diff", "--cached", "--quiet"], { cwd: root, allowFail: true }).ok;
  if (dirty) sh("git", ["commit", "-m", `Remake of ${cfg.url}`, "-m", "Made with https://github.com/rubenhassid1/remake"], { cwd: root });
  const hasOrigin = sh("git", ["remote", "get-url", "origin"], { cwd: root, allowFail: true }).ok;
  if (!hasOrigin) {
    sh("gh", ["repo", "create", name, "--private", "--source", ".", "--remote", "origin", "--push"], { cwd: root });
  } else {
    sh("git", ["push", "-u", "origin", "HEAD"], { cwd: root });
  }
  const repo = sh("gh", ["repo", "view", "--json", "url,visibility", "-q", ".url + \" \" + .visibility"], { cwd: root }).stdout.trim();
  const [repoUrl, visibility] = repo.split(" ");
  if (visibility && visibility !== "PRIVATE") warn(`The repo is ${visibility.toLowerCase()}. A remake should stay private until it's yours.`);
  ok(repoUrl);

  let scope, deployment, url;
  if (host === "cloudflare") {
    step("Deploying to Cloudflare Pages behind a passcode");
    sh("wrangler", ["pages", "project", "create", name, "--production-branch", "main"], { cwd: root, allowFail: true });
    // Cloudflare's API can take a moment to see a project it just created; retry past that lag.
    let secret;
    for (let attempt = 1; attempt <= 5; attempt++) {
      secret = sh("wrangler", ["pages", "secret", "put", "REMAKE_PASSCODE", "--project-name", name], { cwd: root, input: passcode, allowFail: true });
      if (secret.ok || !/does not exist/i.test(secret.out)) break;
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
    if (!secret.ok) throw new RemakeError(`wrangler pages secret put failed:\n${secret.out.trim().slice(-1500)}`);
    const dep = withCloudflareSizeLimit(root, p, cfg, () =>
      sh("wrangler", ["pages", "deploy", "site", "--project-name", name, "--branch", "main", "--commit-dirty"], { cwd: root, allowFail: true }),
    );
    if (!dep.ok) throw new RemakeError(`wrangler pages deploy failed:\n${dep.out.trim().slice(-1500)}`);
    const urls = [...dep.out.matchAll(/https:\/\/[^\s"'\]]+\.pages\.dev/g)].map((m) => m[0]);
    deployment = urls.find((u) => !u.startsWith(`https://${name}.`)) || urls[0];
    url = `https://${name}.pages.dev`; // the production-branch alias; stable across deploys
    ok(`deployed: ${url}`);
  } else {
    step("Deploying to Vercel behind a passcode");
    scope = opts.scope || process.env.REMAKE_VERCEL_SCOPE || prev.scope || currentVercelScope();
    const scoped = (args) => (scope ? [...args, "--scope", scope] : args);
    sh("vercel", scoped(["link", "--yes", "--project", name]), { cwd: root });
    sh("vercel", scoped(["env", "rm", "REMAKE_PASSCODE", "production", "--yes"]), { cwd: root, allowFail: true });
    sh("vercel", scoped(["env", "add", "REMAKE_PASSCODE", "production"]), { cwd: root, input: passcode });
    let dep = sh("vercel", scoped(["deploy", "--prod", "--yes"]), { cwd: root, allowFail: true });
    if (!dep.ok && /Git author .* must have access/i.test(dep.out)) {
      // Vercel only deploys commits whose author is on the team: re-sign the last commit with the Vercel account's email.
      const user = JSON.parse(sh("vercel", ["api", "/v2/user"], { cwd: root, allowFail: true }).stdout || "{}").user || {};
      if (user.email) {
        warn(`Vercel wants the commit author to be ${user.email}; re-signing the last commit with it.`);
        sh("git", ["config", "user.email", user.email], { cwd: root });
        sh("git", ["commit", "--amend", "--reset-author", "--no-edit"], { cwd: root });
        sh("git", ["push", "--force-with-lease", "-u", "origin", "HEAD"], { cwd: root });
        dep = sh("vercel", scoped(["deploy", "--prod", "--yes"]), { cwd: root, allowFail: true });
      }
    }
    if (!dep.ok) throw new RemakeError(`vercel deploy failed:\n${dep.out.trim().slice(-1500)}`);
    const urls = [...dep.out.matchAll(/https:\/\/[^\s"'\]]+\.vercel\.app/g)].map((m) => m[0]);
    const aliased = /Aliased:\s*(https:\/\/\S+)/.exec(dep.out)?.[1];
    deployment = dep.stdout.trim().split("\n").filter((l) => l.startsWith("https://")).pop() || urls[0];
    url = aliased || null;
    if (!url) {
      const inspect = sh("vercel", ["inspect", deployment], { cwd: root, allowFail: true });
      const alias = [...inspect.out.matchAll(/https:\/\/[^\s]+\.vercel\.app/g)].map((m) => m[0]).filter((u) => u !== deployment);
      url = alias.sort((a, b) => a.length - b.length)[0] || deployment;
    }
    ok(`deployed: ${url}`);
  }
  // `vercel link` may add .vercel to .gitignore, and the Cloudflare functions/ folder is new: keep the repo in step with what was deployed.
  sh("git", ["add", "-A"], { cwd: root });
  if (!sh("git", ["diff", "--cached", "--quiet"], { cwd: root, allowFail: true }).ok) {
    sh("git", ["commit", "-m", host === "cloudflare" ? "Cloudflare Pages gate" : "Vercel project link"], { cwd: root });
    sh("git", ["push", "-u", "origin", "HEAD"], { cwd: root });
  }

  step("Checking the passcode gate");
  const check = await verifyGate(url, passcode, first);
  let verified = "no";
  if (check.checkpoint) {
    verified = "checkpoint";
    warn("Vercel's bot check answered the scripted test. Open the link in a browser to confirm the gate.");
  } else if (check.gate && check.unlock && check.page) {
    verified = "yes";
    ok(`locked without the passcode, open with it${check.noindex ? ", hidden from search engines" : ""}`);
  } else {
    warn(`gate check: ${JSON.stringify(check)}`);
  }
  const head = sh("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
  const shipInfo = { name, host, scope, repo: repoUrl, visibility, url, deployment, passcode, verified, check, commit: head, at: new Date().toISOString() };
  writeJson(p.ship, shipInfo);
  say(`\n  Live:     ${url}\n  Passcode: ${passcode}\n  Repo:     ${repoUrl} (${(visibility || "private").toLowerCase()})\n  Proof:    ${url}/_remake/\n  Swap:     ${url}/_remake/swap/`);
  say("\nNext: remake report");
  return shipInfo;
}
