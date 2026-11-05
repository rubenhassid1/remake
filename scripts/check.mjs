// Repo check: every engine file parses, the plugin layout is valid, the skill has its frontmatter.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const fail = [];
const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
walk("engine");
for (const f of files.filter((f) => /\.(m?js)$/.test(f))) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) fail.push(`${f}: ${r.stderr.trim().split("\n")[0]}`);
}
const market = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8"));
for (const p of market.plugins) {
  if (p.source === "./" || p.strict === false) fail.push(`${p.name}: plugins need their own directory and plugin.json`);
  const manifest = path.join(p.source, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifest)) fail.push(`${p.name}: missing ${manifest}`);
  else if (JSON.parse(fs.readFileSync(manifest, "utf8")).version !== p.version) fail.push(`${p.name}: version differs between marketplace and plugin.json`);
}
const skill = fs.readFileSync("plugins/remake/skills/remake/SKILL.md", "utf8");
if (!/^---\r?\nname: remake\r?\ndescription: .{40,}\r?\n---/m.test(skill)) fail.push("SKILL.md frontmatter: needs name and description");
for (const ref of skill.matchAll(/\]\((references\/[^)]+)\)/g)) if (!fs.existsSync(path.join("plugins/remake/skills/remake", ref[1]))) fail.push(`SKILL.md links to missing ${ref[1]}`);
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (pkg.version !== market.plugins[0].version) fail.push("package.json version differs from the plugin version");
if (fail.length) {
  console.log("CHECK FAILED\n" + fail.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log(`CHECK OK: ${files.length} engine files, ${market.plugins.length} plugin, skill frontmatter and links fine.`);
