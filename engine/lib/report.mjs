// Report: the finish line. Prints REMAKE COMPLETE only when every gate passes, so /goal's judge
// (which only reads the conversation) can see the evidence and the verdict in one place.
import fs from "node:fs";
import path from "node:path";
import { verdict } from "./score.mjs";
import { sh } from "./ship.mjs";
import { say, table, readJson, writeJson, newestMtime, writeFile } from "./util.mjs";

export function accept(project, key, reason) {
  const { p, cfg } = project;
  const score = readJson(p.score);
  const v = score ? verdict(score, cfg) : { failing: [] };
  const keyOf = (f) => f.replace(/: [\d.]+%$/, "");
  if (!key || !key.trim()) return say('Name the screen: remake accept "<screen>" --reason "…", exactly as the score lists it.');
  const item = v.failing.find((f) => keyOf(f) === key.trim());
  if (!item) return say(`Nothing failing matches "${key}". Failing now:\n${v.failing.map((f) => "  - " + f).join("\n")}`);
  if (/height|not scored/.test(item)) return say("Height differences and unscored screens can't be accepted: fix them.");
  const pct = Number((/([\d.]+)%/.exec(item) || [])[1] || 0);
  if (pct < 90) return say(`${item}: below 90% can't be accepted. Fix it.`);
  if (!reason || reason.length < 12) return say('Give the reason: remake accept "<screen>" --reason "what differs and why it can\'t match"');
  const list = readJson(p.accepted, []);
  list.push({ key: item.replace(/: [\d.]+%$/, ""), score: pct, reason, at: new Date().toISOString() });
  writeJson(p.accepted, list);
  say(`Accepted: ${item}. Reason: ${reason}`);
}

export function report(project) {
  const { cfg, p, root } = project;
  const ship = readJson(p.ship);
  const content = readJson(p.content);
  // Once the user's own material is in, the match that counts is the one from before the swaps.
  const swapped = (content?.summary?.swapped || 0) > 0;
  const baseline = readJson(path.join(p.work, "score-before-swaps.json"));
  const score = swapped && baseline ? baseline : readJson(p.score);
  const accepted = readJson(p.accepted, []);
  const rows = [["Gate", "Result", "Evidence"]];
  const missing = [];
  const add = (gate, pass, evidence, fix) => {
    rows.push([gate, pass ? "PASS" : "NOT YET", evidence]);
    if (!pass) missing.push(`${gate}: ${fix}`);
  };

  const firstPage = cfg.pages?.[0] || "/";
  const pageFile = path.join(p.site, firstPage.replace(/\/?$/, "/").replace(/^\//, ""), "index.html");
  const captured = !!cfg.capturedAt && (fs.existsSync(pageFile) || fs.existsSync(path.join(p.site, "index.html")));
  const recon = readJson(p.recon, {});
  add("Captured", captured, captured ? `${cfg.pages.length} page(s), ${recon.stats?.files || "?"} files` : "nothing yet", "run `remake capture`");

  let v = { pass: false, failing: ["not scored"] };
  let acceptedNow = [];
  if (score) {
    v = verdict(score, cfg);
    // An accepted screen stays accepted only while it is the same screen and still at 90% or more.
    const keyOf = (f) => f.replace(/: [\d.]+%$/, "");
    const pctOf = (f) => Number((/([\d.]+)%$/.exec(f) || [])[1] || 0);
    acceptedNow = v.failing.filter((f) => pctOf(f) >= 90 && accepted.some((a) => a.key === keyOf(f)));
    v.failing = v.failing.filter((f) => !acceptedNow.includes(f));
  }
  const low = (vp) => {
    const vals = Object.values(score?.pages || {}).filter((x) => x[vp]).map((x) => x[vp].lowest);
    return vals.length ? Math.min(...vals) : null;
  };
  const heights = Object.values(score?.pages || {}).flatMap((x) => Object.values(x).filter((y) => y && y.height)).every((y) => Math.abs(y.height.original - y.height.remake) <= 4);
  const vpFail = (vp) => v.failing.some((f) => f.includes(` ${vp}`));
  for (const vp of Object.keys(cfg.viewports)) {
    const l = low(vp);
    add(`${vp[0].toUpperCase() + vp.slice(1)} match`, l !== null && !vpFail(vp), l === null ? "not scored" : `lowest screen ${l.toFixed(2)}% (pass mark ${cfg.thresholds.screen}%)${heights ? ", heights equal" : ""}`, "fix the screens listed below, then `remake score`");
  }
  const motionOk = score?.motion && !v.failing.some((f) => f.startsWith("motion"));
  const unscorableFrames = score?.motion?.frames.filter((f) => f.unscorable).length || 0;
  add("Motion match", !!motionOk, score?.motion ? `lowest of ${score.motion.frames.length} frames ${score.motion.lowest.toFixed(2)}% (pass mark ${cfg.thresholds.motion}%)${unscorableFrames ? `; ${unscorableFrames} unscorable` : ""}` : "not scored", "fix the motion frames listed below, then `remake score`");

  if (swapped && baseline) {
    add("Score is current", true, `matched before your swaps (${baseline.at.slice(0, 16).replace("T", " ")}); it differs from the original now, on purpose`, "");
  } else {
    const changed = newestMtime(p.site, (f) => f.includes(`${path.sep}_remake${path.sep}`));
    const fresh = score && new Date(score.at).getTime() >= changed - 1000;
    add("Score is current", !!fresh, fresh ? `scored ${score.at.slice(0, 16).replace("T", " ")}` : "site/ changed after the last score", "run `remake score` again");
  }

  const boardOk = content && fs.existsSync(path.join(p.remakeSite, "swap", "index.html")) && fs.existsSync(p.roadmap);
  add("Swap checklist", !!boardOk, content ? `${content.summary.total} slots, ${content.summary.yours}% yours` : "not built", "run `remake slots` then `remake board`");

  let liveOk = false;
  let liveEvidence = "not deployed";
  if (ship) {
    const head = sh("git", ["rev-parse", "HEAD"], { cwd: root, allowFail: true }).stdout?.trim();
    // REPORT.md is written by this command and .gitignore by the Vercel CLI: neither is a site change.
    const changed = (sh("git", ["status", "--porcelain"], { cwd: root, allowFail: true }).stdout || "")
      .split("\n")
      .filter((l) => l.trim() && !/\s(REPORT\.md|\.gitignore)$/.test(l));
    const clean = changed.length === 0;
    const current = head === ship.commit && clean;
    const isPrivate = !ship.visibility || ship.visibility === "PRIVATE";
    const hidden = ship.verified !== "yes" || ship.check?.noindex;
    liveOk = ["yes", "checkpoint"].includes(ship.verified) && current && isPrivate && hidden;
    liveEvidence = `${ship.url} · gate ${ship.verified === "yes" ? "verified" : ship.verified === "checkpoint" ? "behind Vercel's bot check, open it in a browser to confirm" : "not verified"}${isPrivate ? "" : " · the repo is not private"}${hidden ? "" : " · search engines aren't told to stay away"}${current ? "" : " · changes since the last deploy"}`;
  }
  add("Live and private", liveOk, liveEvidence, "run `remake ship` (after the last change)");

  const done = missing.length === 0;
  const lines = [];
  lines.push(`REMAKE REPORT · ${cfg.url}`, "", table(rows));
  if (score) {
    if (v.failing.length) lines.push("", "Still different:", ...v.failing.slice(0, 15).map((f) => `  - ${f}`));
    if (acceptedNow.length) {
      lines.push("", "Accepted differences (reason given):");
      for (const f of acceptedNow) lines.push(`  - ${f}: ${accepted.find((a) => a.key === f.replace(/: [\d.]+%$/, "")).reason}`);
    }
  }
  if (ship) lines.push("", `Live:     ${ship.url}`, `Passcode: ${ship.passcode}`, `Repo:     ${ship.repo} (${(ship.visibility || "PRIVATE").toLowerCase()})`, `Proof:    ${ship.url}/_remake/`, `Swap:     ${ship.url}/_remake/swap/  ·  checklist: MAKE-IT-YOURS.md`);
  lines.push("");
  if (done) lines.push(acceptedNow.length ? `REMAKE COMPLETE (with ${acceptedNow.length} accepted difference${acceptedNow.length > 1 ? "s" : ""})` : "REMAKE COMPLETE");
  else lines.push("REMAKE NOT DONE", ...missing.map((m) => `  - ${m}`));
  const text = lines.join("\n");
  say(text);
  writeFile(p.report, "# Remake report\n\n```\n" + text.replace(/Passcode: .*/, "Passcode: (in remake/ship.json, not committed)") + "\n```\n");
  return { done, missing };
}
