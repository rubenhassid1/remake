#!/usr/bin/env node
// remake: remake any website, pixel for pixel, then make it yours.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, say, RemakeError, readJson, VERSION } from "../lib/util.mjs";
import { loadProject, initProject } from "../lib/project.mjs";

const HELP = `remake ${VERSION}: remake any website, pixel for pixel, then make it yours.

  remake doctor [--fix]          check Node, git, GitHub, Vercel or Cloudflare, and Chromium (--fix installs what it can)
  remake init <url> [--pages N] [--dir path]
                                 start a project (default folder: ~/remakes/<site>)
  remake capture [--archive [timestamp]] [--fresh]
                                 visit once (desktop + phone), write the site into site/
                                 (--archive: the site's files come from the Internet Archive; --fresh: forget the recording)
  remake serve [--port 4310]     run the remake locally; 404s go to remake/missing.log
  remake fetch --missing | <url…>
                                 politely fetch files the remake asked for but didn't have
  remake score [--fresh] [--page /path] [--viewport desktop|phone] [--no-motion]
                                 freeze time, compare every screen and the motion, print PASS or what's off
  remake accept "<screen>" --reason "…"
                                 accept one difference (≥90% only) that can't be fixed, with the reason
  remake slots                   list everything that makes the site theirs → remake/content.json
  remake images [--theme "…"]    measure every image that still belongs to the original → remake/images.json + contact sheets
  remake images --make [--source codex|openai|gemini|stock|art] [--parallel 3]
                                 make the new images (Codex on a ChatGPT plan, an API key, free stock, or generated art)
  remake apply [--force]         put your swaps (content.json "swap" fields) into the site
  remake board                   build the proof page and swap board (site/_remake/) + MAKE-IT-YOURS.md
  remake ship [--host vercel|cloudflare] [--name repo] [--passcode CODE]
                                 private GitHub repo + Vercel or Cloudflare Pages deploy behind a passcode, then check the gate
  remake report                  every gate in one table; ends with REMAKE COMPLETE or what's left
  remake status                  where this project stands and the next command

Run any command from inside the project folder, or pass --dir <folder>.

Made by Ruben Hassid · How to AI: https://ruben.substack.com`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dir = args.dir && cmd !== "init" ? args.dir : process.cwd();
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      return say(HELP);
    case "version":
      return say(VERSION);
    case "doctor": {
      const { doctor } = await import("../lib/doctor.mjs");
      const ready = await doctor({ fix: !!args.fix });
      process.exitCode = ready ? 0 : 1;
      return;
    }
    case "init": {
      const url = args._[1];
      if (!url) throw new RemakeError("Which site?", "remake init https://example.com");
      const r = await initProject(url, { pages: args.pages, dir: args.dir, name: args.name, force: !!args.force });
      if (r.start.status >= 400 || r.start.status === 0) say(`  ! ${url} answered ${r.start.status || r.start.error}. Capture may fail.`);
      say(`${r.existed ? "Project already exists" : "Project ready"}: ${r.root}`);
      say(`  site: ${r.cfg.url}\n  pages: up to ${r.cfg.maxPages}`);
      say(`\nNext: cd "${r.root}" && remake capture`);
      return;
    }
    case "capture": {
      const { capture } = await import("../lib/capture.mjs");
      return capture(loadProject(dir), { archive: args.archive, fresh: !!args.fresh, maxExtra: args["max-extra"], noMedia: !!args["no-media"], noSourceMaps: !!args["no-source-maps"] });
    }
    case "fetch": {
      const { fetchMissing } = await import("../lib/capture.mjs");
      return fetchMissing(loadProject(dir), args._.slice(1));
    }
    case "serve": {
      const { startServer } = await import("../lib/serve.mjs");
      const project = loadProject(dir);
      const s = await startServer(project.p.site, { port: Number(args.port || 4310), missingLog: project.p.missing, quiet: false });
      say(`Remake running at ${s.url}  (proof: ${s.url}/_remake/  swap board: ${s.url}/_remake/swap/)\nMissing files are logged to remake/missing.log. Ctrl+C to stop.`);
      return new Promise(() => {});
    }
    case "score": {
      const { score } = await import("../lib/score.mjs");
      const r = await score(loadProject(dir), { fresh: !!args.fresh, page: args.page, viewport: args.viewport, noMotion: !!args["no-motion"] });
      process.exitCode = r.pass ? 0 : 2;
      return;
    }
    case "accept": {
      const { accept } = await import("../lib/report.mjs");
      return accept(loadProject(dir), args._[1] || "", args.reason);
    }
    case "slots": {
      const { slots } = await import("../lib/slots.mjs");
      return slots(loadProject(dir));
    }
    case "images": {
      const { brief, make } = await import("../lib/images.mjs");
      const project = loadProject(dir);
      return args.make ? make(project, { source: args.source, force: !!args.force, parallel: args.parallel }) : brief(project, { theme: args.theme });
    }
    case "apply": {
      const { apply } = await import("../lib/slots.mjs");
      return apply(loadProject(dir), { force: !!args.force });
    }
    case "board": {
      const { board } = await import("../lib/board.mjs");
      return board(loadProject(dir));
    }
    case "ship": {
      const { ship } = await import("../lib/ship.mjs");
      return ship(loadProject(dir), { host: args.host, name: args.name, passcode: args.passcode, scope: args.scope });
    }
    case "report": {
      const { report } = await import("../lib/report.mjs");
      const r = report(loadProject(dir));
      process.exitCode = r.done ? 0 : 2;
      return;
    }
    case "status":
      return status(loadProject(dir));
    default:
      throw new RemakeError(`Unknown command: ${cmd}`, "Run `remake help`.");
  }
}

function status(project) {
  const { cfg, p } = project;
  const score = readJson(p.score);
  const content = readJson(p.content);
  const ship = readJson(p.ship);
  const steps = [
    ["captured", !!cfg.capturedAt, "remake capture"],
    ["scored", !!score, "remake score"],
    ["score passes", !!score?.pass, "fix the listed screens, then remake score"],
    ["slots listed", !!content, "remake slots"],
    ["proof + swap board", fs.existsSync(path.join(p.remakeSite, "swap", "index.html")), "remake board"],
    ["shipped", !!ship, "remake ship"],
  ];
  say(`${cfg.url}  →  ${project.root}`);
  for (const [name, done] of steps) say(`  ${done ? "✓" : "·"} ${name}`);
  const next = steps.find((s) => !s[1]);
  say(next ? `\nNext: ${next[2]}` : "\nNext: remake report");
  if (content) say(`Swap board: ${content.summary.yours}% yours`);
  if (ship) say(`Live: ${ship.url} (passcode ${ship.passcode})`);
}

main().catch((e) => {
  if (e instanceof RemakeError) {
    say(`\n✗ ${e.message}`);
    if (e.hint) say(`  ${e.hint}`);
    process.exitCode = 1;
  } else {
    say(`\n✗ ${e.stack || e.message}`);
    process.exitCode = 1;
  }
});
