#!/usr/bin/env node
// Personal-tweak (fork/master only): scrub the local username out of the
// packaged CLI bundle. Next.js build manifests (required-server-files.json,
// *_client-reference-manifest.js, *.nft.json) embed the absolute build-time
// path, which on this machine contains the Windows username. Replacing just
// the username token keeps every path internally consistent (same depth) while
// removing the personal identifier. Run between build and npm pack.

const fs = require("fs");
const path = require("path");
const os = require("os");

const cliAppDir = process.env.NINEROUTER_CLI_APP_DIR || path.join(__dirname, "..", "app");

// The MITM sub-build creates a throwaway home dir under app/ with a real
// machine-id file and a runtime-generated database — never ship it.
for (const junk of ["cli", ".build-home"]) {
  const p = path.join(cliAppDir, junk);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`[sanitize] removed build-artifact dir app/${junk}`);
  }
}
const home = path.join(os.homedir(), "9router"); // e.g. C:\Users\<name>\9router
const username = path.basename(path.dirname(home));
if (!username || username === "Users" || username === "") {
  console.log("[sanitize] could not derive username, skipping");
  process.exit(0);
}

const TEXT_EXT = new Set([".js", ".json", ".mjs", ".cjs", ".map", ".txt", ".html", ".css", ".toml", ".md"]);
const RE = new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

let files = 0, hits = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
    let s;
    try { s = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (!RE.test(s)) continue;
    hits += (s.match(RE) || []).length;
    fs.writeFileSync(p, s.replace(RE, "builder"));
    files++;
  }
})(cliAppDir);

console.log(`[sanitize] username '${username}': replaced ${hits} occurrence(s) in ${files} file(s) under app/`);
