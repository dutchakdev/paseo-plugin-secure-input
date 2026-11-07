# Changelog

## Unreleased

### Added

- The pill, the form and the settings screen follow the app's language: English and Korean, and English for any language the plugin does not have. The Ukrainian text is unchanged, and it shows once Paseo offers Ukrainian; until then an app set to another language shows English.

## 0.3.0 - 2026-11-04

Thanks to Bae Seongmin ([@3ae3ae](https://github.com/3ae3ae)), who found and fixed four of the five changes below.

### Changed

- Archiving an agent closes its requests. A pending request stops waiting and its key is wiped, and delivered files are deleted at once instead of at their deadline. A later submission or expiry no longer leaves a message waiting for that agent. A 0.2.x plugin started after this drops the requests closed this way from its history; their files are already gone.
- The skill tells an agent that delegates a move to keep it inside its own turn, because the files go when that turn ends, even while a subagent is still working.
- The README and the plugin directory listing link to the author's other Paseo plugins.

### Fixed

- When a delivery message cannot be sent, the agent's next turn no longer deletes files it was never told about. They stay until their deadline, and `request_status` gives their paths.
- A delivery message that reaches an agent just as another turn starts joins that turn where the agent's provider can steer it, instead of interrupting it.

## 0.2.2 - 2026-11-01

### Fixed

- After a daemon restart, the plugin reaches the agents again as soon as the app reconnects. Paseo 0.15 no longer sets a plugin up again on a reconnect, so a waiting message or pill stayed unsent until an agent next started, ended a turn or opened a session.

## 0.2.1 - 2026-10-28

### Changed

- Shortened the README and moved detailed guidance to SECURITY.md, CONTRIBUTING.md and the agent skill.

### Fixed

- The agent skill's recipes make the destination file private before any byte of a value is written to it. Before, a file that already existed was made private only after the write.

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
