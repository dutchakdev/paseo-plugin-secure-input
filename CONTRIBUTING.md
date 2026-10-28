# Contributing

secure-input is a TypeScript plugin for Paseo 0.14.0-beta.1 and later: a React Native half in the Paseo app (the pill, the form, the settings screen) and a Node.js half on the daemon (the tools, the requests, the sets in `drop/`). A change must keep [SECURITY.md](SECURITY.md) true: no value in a tool result, a message, a pill, a status, an RPC answer, a log or a state file. Update the user documentation when behavior changes, and verify its claims against the implementation.

## Setup

Node.js 22.12.0 or newer and npm, on macOS or Linux, as a user that is not root:

```sh
npm ci
npm run check                        # typecheck the three TypeScript projects, then the full test suite
npm test -- tests/registry.test.ts   # one file
```

The tests use real files, directories and child processes, need `git` and `/bin/sh`, and refuse to run as root: their permission cases need a user the kernel can refuse. The suite passes on macOS and on Linux; the plugin itself has been run on macOS only.

`npm run typecheck` checks three projects. `tsconfig.server.json` holds the daemon half and the tests that load nothing of the app, with Node's types; `tsconfig.client.json` the app half, which runs on Hermes, with neither Node's types nor the DOM's; `tsconfig.client-tests.json` the tests that import modules of `client/`, which bring React Native's global types with them. A new test that imports `client/` goes in the third project and in the exclusions of the first; `tests/client-boundaries.test.ts` fails until it does.

The development SDK (`@getpaseo/*`) is pinned to 0.14.0-beta.1, the oldest release the manifest accepts, so typechecking proves the plugin uses only that API, and `tests/mirrored-constants.test.ts` holds the most one Paseo RPC may carry, which bounds a submission, to that release's protocol and relay. Among the `@getpaseo/*` packages, runtime code imports only `@getpaseo/plugin`; `@getpaseo/client` and `@getpaseo/protocol` stay development dependencies, absent from an npm installation. The runtime dependencies are `@noble/ciphers`, `@noble/curves` and `@noble/hashes`; Paseo supplies `zod`, `react`, `react-native` and `@tanstack/react-query`.

## The documents are tested

`tests/docs.test.ts` holds README.md, SECURITY.md, OVERVIEW.md and the skill to the code where a check can: the tool names, the «…» strings against the app's modules, the plugin's messages and refusals as quoted, the numbers with a unit against the constants behind them, local links and anchors in the checkout, the request examples, the list of ways a set goes, and the `.env`, whole-file and remote-file recipes, which it runs with a value in a real file. It does not validate every prose claim, host behavior, external links or live commands; review those against the source and recorded validation evidence. When a document changes, change what the test claims of it in the same commit; never loosen the test to let a sentence pass. `tests/canary.test.ts` sends recognisable values through the tools and the whole plugin, and fails if one turns up anywhere but in the files in `drop/`.

`docs/preview.png` is rendered from `docs/preview.svg` by `scripts/preview-png.sh` (Chrome and the Swift toolchain, macOS).

## Changelog and releases

Versions follow [semantic versioning](https://semver.org). A pull request with a user-visible change adds an entry under `## Unreleased` at the top of `CHANGELOG.md`, in the `Added`, `Changed`, `Fixed` or `Removed` group. That section becomes the release notes, so write for people who run the plugin.

To cut a release from an up-to-date `main`:

```sh
node scripts/release.mjs prepare minor   # or patch, major, premajor, preminor, prepatch, prerelease (beta id), or 1.2.3-beta.1
npm run check
```

`prepare` dates the Unreleased section, sets the version in `package.json` and `package-lock.json`, and prints the commit, push and tag commands. It does not touch `PLUGIN_VERSION` in `shared/limits.ts`, which the settings screen shows: set it, and the version `tests/mirrored-constants.test.ts` expects of it, before the commit, or `npm run check` fails. Pushing the `v` tag starts the [Release workflow](.github/workflows/release.yml), which checks that the tag is on `main`, matches `package.json`, has a dated changelog section and is newer than everything on npm; packs and checks the tarball; runs the suite on macOS and Ubuntu with Node 22.12 and 24; publishes with `npm publish --provenance`; and creates the GitHub release from the changelog. Prereleases go to the `next` dist-tag and are marked as prereleases on GitHub.

A run that failed for a reason outside the tagged commit, such as npm settings or a flaky runner, can be run again from the same tag with `gh workflow run release.yml --ref vX.Y.Z`; a version already on npm is not published again, and the run only completes the GitHub release. A fix to the code needs a new version.

Publishing uses npm trusted publishing, so the repository stores no npm token: the trusted publisher on npmjs.com names repository `dutchakdev/paseo-plugin-secure-input`, workflow `release.yml` and environment `npm`. Keep that environment limited to `v*` tags in the repository settings, since npm does not check which ref a run started from.

`npm pack` and `npm publish` run `prepack`, which writes `npm-shrinkwrap.json` (the production part of `package-lock.json`: the three `@noble/*` packages), and `postpack`, which deletes it. npm publishes the shrinkwrap and honors it when Paseo installs the plugin; the plugin directory requires it for a package with runtime dependencies, and `scripts/check-package.mjs` rejects a tarball without it, or with what the plugin does not run from (`tests/`, `docs/`, `scripts/`, `.github/`). It stays out of Git, because npm would prefer it to `package-lock.json` for development installs; if packing is interrupted, run `node scripts/shrinkwrap.mjs remove`.

The plugin directory on paseo.sh pins an npm version: once the plugin is listed, a new npm release reaches its listing through a bump pull request in [getpaseo/plugins](https://github.com/getpaseo/plugins), and the listing changes when a reviewer approves it. The listing text is `OVERVIEW.md` in the package: update it when setup or behavior changes, and keep install commands out of it, which the directory rejects and so does `scripts/check-package.mjs`. Paseo Cafe expects npm's `latest` to match `package.json` on `main`, so push the tag right after the release commit.

## Live validation

Run the plugin from the checkout with `paseo plugin install "$PWD"`. After each edit, reload it rather than restarting the daemon; source edits are not picked up by themselves:

```sh
paseo plugin reload secure-input
paseo plugin ls          # expect: running
paseo plugin logs secure-input
```

`running` covers the daemon half only. The app checks its own version before it runs the client half, so check the pill, the form and the settings screen in the app as well, on the desktop and on a phone, in light and dark themes, and press «Перевірити» on each. Use test values, never a real secret. Report automated checks separately from what you saw in the app.

Observed on Paseo 0.14.0-beta.1 with Claude Code 2.1.311 and Codex 0.164.0: Claude Code lists the tools as `mcp__paseo__request_secret` and the other three alike, deferred until loaded with `ToolSearch`; Codex has them as nested tools of `exec`, listed in `ALL_TOOLS`, and one Codex model did not find them until told to look there. In Claude Code's `default` mode and Codex's `auto` mode every call asked for permission, and Claude Code also before each `cp` of a delivered file. Kimi and other modes were not tried.

## Issues and pull requests

For a bug, include the steps to reproduce it, what you expected and what happened, the plugin, daemon and app versions, the daemon's OS and the agent. Leave out every real secret, the content of any `si-secret-` file, private paths and host names. A vulnerability goes through the private report that [SECURITY.md](SECURITY.md#reporting) describes, never an issue.

A pull request explains the resulting behavior, the tests that hold it and the documents it changed, and says what was not checked live. Keep changes focused so they can be reviewed on their own.
