import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectShrinkwrap, productionShrinkwrap } from "./shrinkwrap.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The tarball is what npm, Paseo Cafe and the Paseo plugin directory install. One file stands for each directory the
// plugin runs from: `client/`, `server/`, `shared/` and the agent skill in `skills/`.
const REQUIRED = [
  "package.json", "npm-shrinkwrap.json", "paseo-plugin.json", "OVERVIEW.md", "README.md", "SECURITY.md", "LICENSE", "assets/icon.png",
  "index.client.tsx", "index.server.ts", "client/card.tsx", "server/paseo/plugin.ts", "shared/contracts.ts", "skills/secure-input/SKILL.md",
];
const FORBIDDEN = ["tests/", "docs/", ".superpowers/", "scripts/", ".github/", "node_modules/"];
// The plugin directory rejects overviews that carry install commands.
const OVERVIEW_COMMANDS = /paseo plugin add|npm install|\bnpm i\b/;

/** Problems with a packed tarball, given its file list and the files the registry reads. */
export function inspectPackage({ files, manifest, overview, sourceManifest, packageJson, shrinkwrap }) {
  const problems = [];
  for (const file of REQUIRED) if (!files.includes(file)) problems.push(`missing ${file}`);
  for (const file of files) if (FORBIDDEN.some((prefix) => file.startsWith(prefix))) problems.push(`unexpected ${file}`);
  if (JSON.stringify(manifest) !== JSON.stringify(sourceManifest)) problems.push("paseo-plugin.json differs from the source manifest");
  // The plugin directory resolves the manifest icon inside the tarball.
  if (manifest?.icon && !files.includes(manifest.icon)) problems.push(`missing ${manifest.icon}, the manifest icon`);
  if (overview !== undefined && OVERVIEW_COMMANDS.test(overview)) problems.push("OVERVIEW.md contains an install command");
  // Paseo installs npm plugins with npm, which honors only a published shrinkwrap: it fixes the `@noble/*` the plugin runs on.
  if (packageJson) problems.push(...inspectShrinkwrap(shrinkwrap, packageJson));
  return problems;
}

// npm may rewrite the form of `package.json`, and `prepack` writes the shrinkwrap: both are compared as parsed JSON.
const AS_JSON = new Set(["package.json", "npm-shrinkwrap.json"]);

function sameJson(packed, source) {
  try {
    return isDeepStrictEqual(JSON.parse(packed), JSON.parse(source));
  } catch {
    return false;
  }
}

/**
 * The packed files that are not what the source holds: byte for byte, or as JSON for the two files npm and `prepack`
 * write. A file with no source differs.
 */
export function compareFiles(files, readPacked, readSource) {
  const problems = [];
  for (const file of files) {
    const packed = readPacked(file);
    const source = readSource(file);
    if (!source || (AS_JSON.has(file) ? !sameJson(packed, source) : !packed.equals(source))) problems.push(`${file} differs from the source`);
  }
  return problems;
}

/**
 * The source of a packed file is the commit checked out, read from Git, and not the working tree: a pack step that
 * rewrites a file in the checkout as well as in the tarball is caught. The shrinkwrap's source is what
 * `productionShrinkwrap` makes of that commit's lockfile and manifest, so a changed `resolved` or `integrity` is caught too.
 */
function committed(file) {
  try {
    return execFileSync("git", ["-C", root, "show", `HEAD:${file}`], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

function committedShrinkwrap() {
  try {
    const json = (file) => JSON.parse(committed(file)?.toString("utf8") ?? "null");
    return Buffer.from(JSON.stringify(productionShrinkwrap(json("package-lock.json"), json("package.json"))));
  } catch {
    return undefined;
  }
}

function tar(tarball, ...args) {
  return execFileSync("tar", [...args, tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tarball = process.argv[2];
  if (!tarball) {
    console.error("Usage: node scripts/check-package.mjs <package.tgz>");
    process.exit(2);
  }
  const files = tar(tarball, "-tzf").split("\n").filter(Boolean).map((entry) => entry.replace(/^package\//, ""));
  const extract = (file) => (files.includes(file) ? execFileSync("tar", ["-xOzf", tarball, `package/${file}`], { encoding: "utf8" }) : undefined);
  const problems = inspectPackage({
    files,
    manifest: JSON.parse(extract("paseo-plugin.json") ?? "null"),
    overview: extract("OVERVIEW.md"),
    sourceManifest: JSON.parse(readFileSync(join(root, "paseo-plugin.json"), "utf8")),
    packageJson: JSON.parse(extract("package.json") ?? "null"),
    shrinkwrap: JSON.parse(extract("npm-shrinkwrap.json") ?? "null"),
  });
  problems.push(...compareFiles(
    files.filter((file) => file && !file.endsWith("/")),
    (file) => execFileSync("tar", ["-xOzf", tarball, `package/${file}`], { maxBuffer: 64 * 1024 * 1024 }),
    (file) => (file === "npm-shrinkwrap.json" ? committedShrinkwrap() : committed(file)),
  ));
  if (problems.length) {
    console.error(`${tarball}:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${tarball}: ${files.length} files, content, manifest, overview and shrinkwrap as expected.`);
}
