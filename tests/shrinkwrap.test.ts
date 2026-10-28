import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error The packaging helpers are plain ESM without declarations.
import { inspectShrinkwrap, productionShrinkwrap } from "../scripts/shrinkwrap.mjs";
// @ts-expect-error The packaging helpers are plain ESM without declarations.
import { inspectPackage } from "../scripts/check-package.mjs";

const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8"));
const lock = read("package-lock.json");
const packageJson = read("package.json");
type Entry = { version: string; resolved: string; integrity: string; dev?: boolean };

describe("published shrinkwrap", () => {
  const shrinkwrap = productionShrinkwrap(lock, packageJson);
  const paths = Object.keys(shrinkwrap.packages).filter((path) => path !== "");

  it("locks every runtime dependency with its exact version, registry source and integrity", () => {
    for (const name of Object.keys(packageJson.dependencies)) {
      const entry: Entry = shrinkwrap.packages[`node_modules/${name}`];
      expect(entry).toEqual(lock.packages[`node_modules/${name}`]);
      expect(entry.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity).toMatch(/^sha512-/);
    }
    expect(inspectShrinkwrap(shrinkwrap, packageJson)).toEqual([]);
  });

  it("leaves out the development tree, which npm never installs for a dependency", () => {
    const production = Object.entries(lock.packages as Record<string, Entry & { devOptional?: boolean }>)
      .filter(([path, entry]) => path !== "" && !entry.dev && !entry.devOptional).map(([path]) => path);
    expect(paths.sort()).toEqual(production.sort());
    expect(shrinkwrap.packages[""]).not.toHaveProperty("devDependencies");
    // The plugin runs on the three libraries of its cryptography and on nothing else of its own.
    expect(paths.sort()).toEqual(["node_modules/@noble/ciphers", "node_modules/@noble/curves", "node_modules/@noble/hashes"]);
  });

  it("refuses a lock that does not satisfy package.json", () => {
    const stale = structuredClone(lock);
    stale.packages["node_modules/@noble/ciphers"].version = "1.0.0";
    expect(() => productionShrinkwrap(stale, packageJson)).toThrow("does not satisfy");
  });

  it("names an entry that lacks an exact version, a registry source or a sha512 integrity", () => {
    const path = "node_modules/@noble/ciphers";
    const good = shrinkwrap.packages[path] as Entry;
    const lacking = (at: string) => `${at} lacks an exact version, registry source, or sha512 integrity`;
    const changed = (changes: Record<string, unknown>, at = path) =>
      inspectShrinkwrap({ ...shrinkwrap, packages: { ...shrinkwrap.packages, [at]: { ...good, ...changes } } }, packageJson);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["a source that is not the registry", { resolved: "https://example.com/ciphers-2.4.0.tgz" }],
      ["a source over git", { resolved: "git+ssh://git@github.com/paulmillr/noble-ciphers.git#0123456789abcdef" }],
      ["no source", { resolved: undefined }],
      ["an integrity that is not sha512", { integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
      ["no integrity", { integrity: undefined }],
    ];
    for (const [name, changes] of cases) expect(changed(changes), name).toEqual([lacking(path)]);
    // No version fails the range the dependency asks for as well; the entry is named all the same.
    expect(changed({ version: undefined })).toContain(lacking(path));
    // Every entry is held to it, one that no dependency of the package names included.
    expect(changed({ integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }, "node_modules/transitive")).toEqual([lacking("node_modules/transitive")]);
  });

  it("names a tarball without a shrinkwrap, or with one for another version", () => {
    const files = ["npm-shrinkwrap.json"];
    expect(inspectShrinkwrap(null, packageJson)).toEqual(["missing npm-shrinkwrap.json"]);
    expect(inspectShrinkwrap({ ...shrinkwrap, version: "0.0.1" }, packageJson)[0]).toContain("not paseo-plugin-secure-input@");
    expect(inspectPackage({ files, manifest: null, sourceManifest: {}, packageJson, shrinkwrap: null })).toContain("missing npm-shrinkwrap.json");
  });
});
