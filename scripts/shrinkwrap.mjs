import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import semver from "semver";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shrinkwrapPath = join(root, "npm-shrinkwrap.json");

// npm publishes npm-shrinkwrap.json and honors it when the package is installed
// as a dependency, which is how Paseo installs npm plugins; package-lock.json is
// neither published nor honored there. The tarball therefore carries a lock of
// the production tree only, derived from package-lock.json at pack time, and the
// repository keeps package-lock.json for development.

const isProduction = (entry) => !entry.dev && !entry.devOptional;

/** The production-only shrinkwrap for `packageJson`, taken from its lockfile. */
export function productionShrinkwrap(lock, packageJson) {
  if (lock.lockfileVersion < 2 || !lock.packages) throw new Error("package-lock.json must use lockfileVersion 2 or newer.");
  const { name, version, license, dependencies = {}, engines } = packageJson;
  const packages = { "": { name, version, ...(license ? { license } : {}), dependencies, ...(engines ? { engines } : {}) } };
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "" || !isProduction(entry)) continue;
    packages[path] = entry;
  }
  const shrinkwrap = { name, version, lockfileVersion: 3, requires: true, packages };
  const problems = inspectShrinkwrap(shrinkwrap, packageJson);
  if (problems.length) throw new Error(`package-lock.json cannot lock the production tree:\n  ${problems.join("\n  ")}`);
  return shrinkwrap;
}

/** Problems that would let npm resolve a production dependency differently from the lock. */
export function inspectShrinkwrap(shrinkwrap, packageJson) {
  if (!shrinkwrap) return ["missing npm-shrinkwrap.json"];
  const problems = [];
  if (shrinkwrap.name !== packageJson.name || shrinkwrap.version !== packageJson.version) {
    problems.push(`npm-shrinkwrap.json names ${shrinkwrap.name}@${shrinkwrap.version}, not ${packageJson.name}@${packageJson.version}`);
  }
  const packages = shrinkwrap.packages ?? {};
  for (const [name, range] of Object.entries(packageJson.dependencies ?? {})) {
    const entry = packages[`node_modules/${name}`];
    if (!entry) { problems.push(`npm-shrinkwrap.json does not lock ${name}`); continue; }
    if (!semver.satisfies(entry.version, range)) problems.push(`${name}@${entry.version} does not satisfy ${range}`);
  }
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "") continue;
    if (!isProduction(entry)) problems.push(`npm-shrinkwrap.json includes development package ${path}`);
    if (!entry.version || !entry.resolved?.startsWith("https://registry.npmjs.org/") || !entry.integrity?.startsWith("sha512-")) {
      problems.push(`${path} lacks an exact version, registry source, or sha512 integrity`);
    }
  }
  return problems;
}

async function write() {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(shrinkwrapPath, `${JSON.stringify(productionShrinkwrap(lock, packageJson), null, 2)}\n`);
}

async function remove() {
  if (existsSync(shrinkwrapPath)) await rm(shrinkwrapPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "write") await write();
  else if (command === "remove") await remove();
  else throw new Error("Usage: node scripts/shrinkwrap.mjs <write|remove>");
}
