// Ship to Railway: a private GitHub repo, a Railway service that runs server.mjs (a static server for
// site/ with the same passcode gate as the Vercel middleware), then a check from outside that the gate holds.
// Used by `remake ship --host railway` (or `--railway`). Later ships remember the host in remake/ship.json.
import fs from "node:fs";
import path from "node:path";
import { TEMPLATES } from "./project.mjs";
import { sh, saveToGitHub, prepareSite, shipName, makePasscode, verifyGate } from "./ship.mjs";
import { RemakeError, say, ok, warn, step, readJson, writeJson } from "./util.mjs";

const SERVICE = "web";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Railway prints notices around its JSON: take the last JSON object or array in the output.
function lastJson(text) {
  const s = String(text || "");
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== "{" && s[i] !== "[") continue;
    try {
      return JSON.parse(s.slice(i));
    } catch {}
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{" && s[i] !== "[") continue;
    try {
      return JSON.parse(s.slice(i));
    } catch {}
  }
  return null;
}

const rw = (args, opts = {}) => sh("railway", args, { allowFail: true, ...opts });

// Swap the Vercel files for the Railway ones. Files the user changed are left alone, with a warning.
function railwayFiles(root, cfg) {
  const server = path.join(root, "server.mjs");
  if (!fs.existsSync(server)) {
    fs.copyFileSync(path.join(TEMPLATES, "railway", "server.mjs"), server);
    ok("server.mjs: static server for site/ with the passcode gate");
  }
  const pkgFile = path.join(root, "package.json");
  const pkg = readJson(pkgFile, {}) || {};
  pkg.name = pkg.name || cfg.name;
  pkg.private = true;
  pkg.type = "module";
  pkg.engines = { ...(pkg.engines || {}), node: pkg.engines?.node || ">=20" };
  pkg.scripts = { ...(pkg.scripts || {}), start: "node server.mjs" };
  delete pkg.scripts.build; // nothing to build: the site is static files
  if (pkg.dependencies) {
    delete pkg.dependencies["@vercel/functions"];
    if (!Object.keys(pkg.dependencies).length) delete pkg.dependencies;
  }
  writeJson(pkgFile, pkg);
  for (const [file, marker] of [["middleware.js", "Vercel Routing Middleware"], ["vercel.json", "openapi.vercel.sh"]]) {
    const f = path.join(root, file);
    if (!fs.existsSync(f)) continue;
    if (fs.readFileSync(f, "utf8").includes(marker)) fs.rmSync(f);
    else warn(`${file} looks edited, so it stays. Railway ignores it.`);
  }
  const gi = path.join(root, ".gitignore");
  const lines = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8").split("\n") : [];
  if (!lines.includes(".railway")) fs.writeFileSync(gi, [".railway", ...lines].join("\n"));
  const ri = path.join(root, ".railwayignore");
  if (!fs.existsSync(ri)) fs.writeFileSync(ri, "remake/\nnode_modules/\n.git/\n");
  const readme = path.join(root, "README.md");
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, "utf8")
      .replace("This folder is what Vercel serves.", "This folder is what Railway serves (through `server.mjs`).")
      .replace(/\| `middleware\.js` \| The passcode gate\. Remove the `REMAKE_PASSCODE` variable on Vercel to open the site\. \|/, "| `server.mjs` | The server and passcode gate. Remove the `REMAKE_PASSCODE` variable on Railway to open the site. |");
    fs.writeFileSync(readme, text);
  }
}

// The project and service this folder deploys to: the ones from the last ship, else new ones.
function railwayProject(root, name, prev, opts) {
  const workspace = opts.workspace || opts.scope || process.env.REMAKE_RAILWAY_WORKSPACE || prev.workspace || null;
  const service = prev.service || SERVICE;
  let project = prev.project || null;
  if (!project) {
    const args = ["init", "--name", name, "--json"];
    if (workspace) args.push("--workspace", workspace);
    const r = rw(args, { cwd: root });
    project = lastJson(r.out)?.id;
    if (!r.ok || !project) {
      throw new RemakeError(`railway init failed:\n${r.out.trim().slice(-1200)}`, "If you belong to several Railway workspaces, pass --workspace <name or id>.");
    }
    ok(`Railway project ${name} (${project})`);
    const add = rw(["add", "--service", service, "--json"], { cwd: root });
    if (!add.ok && !/already exists/i.test(add.out)) throw new RemakeError(`railway add failed:\n${add.out.trim().slice(-1200)}`);
  }
  const link = rw(["link", "--project", project, "--service", service, "--environment", prev.environment || "production", "--json"], { cwd: root });
  if (!link.ok) throw new RemakeError(`railway link failed:\n${link.out.trim().slice(-1200)}`, "Check the project still exists: `railway list`.");
  return { project, service, workspace, environment: prev.environment || "production" };
}

async function waitForDeployment(root, service, id, { timeoutMs = 15 * 60_000 } = {}) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const list = lastJson(rw(["deployment", "list", "--service", service, "--limit", "10", "--json"], { cwd: root }).out) || [];
    const dep = (id && list.find((d) => d.id === id)) || list[0];
    const status = dep?.status || "UNKNOWN";
    if (status !== last) {
      say(`  ${status.toLowerCase()}…`);
      last = status;
    }
    if (status === "SUCCESS") return dep;
    if (["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(status)) {
      throw new RemakeError(`The Railway deployment ${dep.id} ended as ${status}.`, `Read the logs: \`railway logs --deployment ${dep.id} --lines 100\`.`);
    }
    await sleep(5000);
  }
  throw new RemakeError("The Railway deployment didn't finish within 15 minutes.", "Check it with `railway deployment list` and `railway logs`.");
}

function railwayDomain(root, service) {
  const list = () => (lastJson(rw(["domain", "list", "--service", service, "--json"], { cwd: root }).out)?.domains || []);
  let domains = list();
  if (!domains.length) {
    const made = rw(["domain", "--service", service, "--json"], { cwd: root });
    if (!made.ok) throw new RemakeError(`railway domain failed:\n${made.out.trim().slice(-1200)}`);
    domains = list();
  }
  // A custom domain the user added wins over the generated *.up.railway.app one.
  const pick = domains.find((d) => d.type && d.type !== "service") || domains[0];
  if (!pick?.domain) throw new RemakeError("Railway gave no domain for the service.", "Run `railway domain` in the project folder.");
  return `https://${pick.domain}`;
}

async function waitForAnswer(url, timeoutMs = 3 * 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status === 401 || r.status === 200) return r.status;
    } catch {}
    await sleep(4000);
  }
  return null;
}

export async function shipRailway(project, opts = {}, prev = {}) {
  const { cfg, p, root } = project;
  const first = prepareSite(project);
  const name = shipName(project, opts, prev);
  const passcode = opts.passcode || prev.passcode || makePasscode(cfg.name);

  step("Checking you're signed in to GitHub and Railway");
  if (!sh("gh", ["auth", "status"], { allowFail: true }).ok) {
    throw new RemakeError("GitHub CLI isn't signed in.", "Run `gh auth login --web` and click through once in your browser.");
  }
  if (!rw(["--version"]).ok) throw new RemakeError("The Railway CLI isn't installed.", "Run `brew install railway` or `npm install -g @railway/cli`.");
  const who = rw(["whoami"]);
  if (!who.ok) throw new RemakeError("Railway CLI isn't signed in.", "Run `railway login` and click through once in your browser.");
  ok(`GitHub and Railway (${who.stdout.trim().split("\n").pop()})`);

  step("Preparing the Railway files");
  railwayFiles(root, cfg);

  const { repoUrl, visibility } = saveToGitHub(root, cfg, name);
  const commit = sh("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

  step("Deploying to Railway behind a passcode");
  const rp = railwayProject(root, name, prev, opts);
  const v = rw(["variable", "set", "REMAKE_PASSCODE", "--stdin", "--service", rp.service, "--skip-deploys"], { cwd: root, input: passcode });
  if (!v.ok) throw new RemakeError(`Setting REMAKE_PASSCODE on Railway failed:\n${v.out.trim().slice(-1200)}`);
  ok("REMAKE_PASSCODE set on the service");
  const up = rw(["up", "--detach", "--json", "--service", rp.service, "--message", `Remake ${commit.slice(0, 7)}`], { cwd: root });
  if (!up.ok) throw new RemakeError(`railway up failed:\n${up.out.trim().slice(-1500)}`);
  const upJson = lastJson(up.out) || {};
  const deploymentId = upJson.deploymentId || upJson.id || (/"(?:deploymentId|id)"\s*:\s*"([0-9a-f-]{36})"/.exec(up.out) || [])[1] || (/[?&]id=([0-9a-f-]{36})/.exec(up.out) || [])[1] || null;
  const dep = await waitForDeployment(root, rp.service, deploymentId);
  ok(`deployment ${dep.id} is live`);
  const url = railwayDomain(root, rp.service);
  ok(`deployed: ${url}`);

  step("Checking the passcode gate");
  if (!(await waitForAnswer(url))) warn("The domain didn't answer yet; new Railway domains can take a minute.");
  const check = await verifyGate(url, passcode, first);
  let verified = "no";
  if (check.gate && check.unlock && check.page) {
    verified = "yes";
    ok(`locked without the passcode, open with it${check.noindex ? ", hidden from search engines" : ""}`);
  } else {
    warn(`gate check: ${JSON.stringify(check)}`);
  }
  const shipInfo = {
    host: "railway",
    name,
    workspace: rp.workspace,
    project: rp.project,
    service: rp.service,
    environment: rp.environment,
    repo: repoUrl,
    visibility,
    url,
    deployment: dep.id,
    passcode,
    verified,
    check,
    commit,
    at: new Date().toISOString(),
  };
  writeJson(p.ship, shipInfo);
  say(`\n  Live:     ${url}\n  Passcode: ${passcode}\n  Repo:     ${repoUrl} (${(visibility || "private").toLowerCase()})\n  Proof:    ${url}/_remake/\n  Swap:     ${url}/_remake/swap/`);
  say("\nNext: remake report");
  return shipInfo;
}
