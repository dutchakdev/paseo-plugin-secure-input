# Changelog

## Unreleased

### Changed

- The documentation is rewritten shorter: the README holds what you need to install and use the plugin, and the details live in SECURITY.md, CONTRIBUTING.md and the skill.

## 0.2.0 - 2026-10-28

The first published release. It replaces 0.1.0, which was never published: the plugin no longer writes a value into a file or a command itself. It hands the agent a short-lived file instead, which the agent moves where the value belongs without reading it.

### Added

- One tool to ask for secrets, `request_secret`, with `request_status`, `cancel_request` and `release_secret` beside it. An agent asks for named keys, some of them optional, or for none, and you can add keys of your own in the form.
- Each value, or a whole file, lands in a short-lived set: a directory of mode 0700 in the plugin's data directory, with one file of mode 0600 for each key you filled in. The agent is given the paths, never the values, and moves each value by redirection or by copy; the skill shows how, into an `.env` file that git ignores, a file of its own, a tool's stdin or a server.
- A set is deleted when the agent releases it, at the end of the agent's turn that its delivery message starts, 15 minutes after the write, and at every start and stop of the plugin.
- A pill in the agent's chat for each request, with the key names and never a value. Pressing it opens the form; nothing opens by itself.
- The form: one hidden row per key, with an eye to show it, rows of your own, and file rows. A file row takes a whole file of up to 128 KiB, binary included: picked or dropped on the desktop, pasted on the desktop and on the phone. A file the agent asks for as `json` or `pem` is checked in the app before anything is sealed.
- The **Secure input** settings screen. «Перевірити» seals the largest submission one request can carry on this device and has the plugin open it; «Стан» shows whether the plugin runs, the sets on the daemon, the requests that wait for you and the first problem; «Видалити всі файли секретів зараз» deletes every set at once.
- A plugin icon, which the Paseo plugin directory shows on the listing.
- Published to npm as `paseo-plugin-secure-input`. The package carries an `npm-shrinkwrap.json`, which fixes the version, source and integrity of the `@noble/*` libraries the plugin runs on, and `OVERVIEW.md`, which the Paseo plugin directory shows on the plugin's page.

### Changed

- Requires Paseo 0.14.0-beta.1 or later, on the daemon and in the app, and Paseo's tools given to agents (`daemon.mcp.injectIntoAgents`). Paseo serves the plugin's tools beside its own and tells the plugin which agent made each call; agents see them as `mcp__paseo__request_secret` and so on.
- The tools: `request_input` is now `request_secret`, `list_commands` went with the command templates, and `release_secret` is new.
- The request's card is now a pill, and the dialog a form that shows neither the agent's reason nor a destination: the agent says why it asks in its own message.
- One skill, `secure-input`, in place of two.

### Removed

- Destinations: the plugin no longer writes into a dotenv file or a file itself, and no longer runs command templates (`commands.json`).
- The plugin's own MCP server and its bridge, the `secure-input` command line that agents without those tools used (`SECURE_INPUT_CLI`), and the bindings by which it told which agent was calling (`SECURE_INPUT_BINDING`, `bindings.json`). Where 0.1.0 was installed, `bin/` in the data directory keeps a stub for the agents created under it: it lists no tools, and says that the tools now come through Paseo.
- The `secure-input-setup` skill, and the `dotenv` dependency.
