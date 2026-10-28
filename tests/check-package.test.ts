import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error The packaging helpers are plain ESM without declarations.
import { inspectPackage } from "../scripts/check-package.mjs";
// @ts-expect-error The packaging helpers are plain ESM without declarations.
import { productionShrinkwrap } from "../scripts/shrinkwrap.mjs";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
const sourceManifest = JSON.parse(read("paseo-plugin.json"));
const packageJson: { files: string[] } = JSON.parse(read("package.json"));
const shrinkwrap = productionShrinkwrap(JSON.parse(read("package-lock.json")), packageJson);
const files = [
  "package.json", "npm-shrinkwrap.json", "paseo-plugin.json", "OVERVIEW.md", "README.md", "SECURITY.md", "LICENSE", "assets/icon.png",
  "index.client.tsx", "index.server.ts", "client/card.tsx", "server/paseo/plugin.ts", "shared/contracts.ts", "skills/secure-input/SKILL.md",
];
const inspect = (overrides: Record<string, unknown>) =>
  inspectPackage({ files, manifest: sourceManifest, overview: read("OVERVIEW.md"), sourceManifest, packageJson, shrinkwrap, ...overrides });

describe("packed tarball", () => {
  it("accepts the repository's own manifest, overview and shrinkwrap", () => {
    expect(inspect({})).toEqual([]);
  });

  it("names each file it requires when that one is missing, and the development files that leaked in", () => {
    // `files` is what a tarball must hold, written out here and not read from the check. Leaving each file out in turn
    // fails for a file the check has stopped asking for; the test above fails for one the check asks for and this list lacks.
    for (const file of files) {
      const named = [`missing ${file}`, ...(file === sourceManifest.icon ? [`missing ${file}, the manifest icon`] : [])];
      expect(inspect({ files: files.filter((other) => other !== file) }), `without ${file}`).toEqual(named);
    }
    const leaked = ["tests/canary.test.ts", "docs/preview.png", ".superpowers/notes.md", "scripts/release.mjs", ".github/workflows/ci.yml", "node_modules/zod/package.json"];
    expect(inspect({ files: [...files.filter((file) => file !== "OVERVIEW.md" && file !== "skills/secure-input/SKILL.md"), ...leaked] })).toEqual([
      "missing OVERVIEW.md",
      "missing skills/secure-input/SKILL.md",
      ...leaked.map((file) => `unexpected ${file}`),
    ]);
  });

  it("rejects a manifest that differs from the source", () => {
    expect(inspect({ manifest: { ...sourceManifest, requirements: { paseo: ">=0.13.0" } } })).toEqual(["paseo-plugin.json differs from the source manifest"]);
  });

  it("requires the icon the manifest declares, which the plugin directory reads from the tarball", () => {
    expect(inspect({ files: files.filter((file) => file !== "assets/icon.png") })).toEqual(["missing assets/icon.png", "missing assets/icon.png, the manifest icon"]);
  });

  it("rejects an overview with an install command, which the plugin directory refuses", () => {
    expect(inspect({ overview: "Run `paseo plugin add dutchakdev/secure-input`." })).toEqual(["OVERVIEW.md contains an install command"]);
    expect(inspect({ overview: "Or npm install paseo-plugin-secure-input." })).toEqual(["OVERVIEW.md contains an install command"]);
    expect(inspect({ overview: "Then npm i the CLI." })).toEqual(["OVERVIEW.md contains an install command"]);
  });

  it("keeps the repository's own overview free of install commands", () => {
    expect(read("OVERVIEW.md")).not.toMatch(/paseo plugin add|npm install|\bnpm i\b/);
  });

  it("requires the shrinkwrap that fixes the runtime dependencies", () => {
    expect(inspect({ shrinkwrap: null })).toEqual(["missing npm-shrinkwrap.json"]);
  });

  // The files the check requires reach the tarball only through `files` in package.json, but for what npm always packs.
  it("asks only for what package.json ships", () => {
    const always = ["package.json", "README.md", "LICENSE"];
    const shipped = (file: string) => always.includes(file) || packageJson.files.some((entry) => entry === file || (entry.endsWith("/") && file.startsWith(entry)));
    expect(files.filter((file) => !shipped(file))).toEqual([]);
    expect(packageJson.files).toEqual(expect.arrayContaining(["npm-shrinkwrap.json", "OVERVIEW.md", "skills/", "SECURITY.md"]));
  });
});
