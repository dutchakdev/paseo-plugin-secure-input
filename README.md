![secure-input](docs/preview.png)

secure-input is a [Paseo](https://paseo.sh) plugin: an agent asks you for a password, an API key, a token or a whole credentials file in a form in the Paseo app instead of in the chat. The app seals what you enter, the daemon writes each value to a short-lived file that only your OS user can read, and the agent gets the paths, never the values, and moves each one where it belongs without reading it. The texts of the pill, the form and the settings screen are in Ukrainian only.

## Install

You need Paseo **0.14.0-beta.1 or later** on the daemon and in every app you answer from: an older app shows no pill, and `paseo plugin ls` says nothing about the app. Paseo 0.14.0-beta.1 is a pre-release: on 2026-10-28 npm had it under the Paseo CLI's `beta` dist-tag, and `latest` was 0.13.2. The daemon's Node.js must be 22.12 or later, on macOS or Linux. Check both versions:

```bash
paseo daemon status          # daemonVersion
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Paseo.app/Contents/Info.plist   # the macOS app
```

Enable plugins daemon-wide under **Settings → Plugins → Enable plugins** (the root `pluginsEnabled` field in the daemon's `config.json`), and give agents Paseo's own tools, which bring this plugin's with them. A fresh home of Paseo 0.14.0-beta.1 has that off; the setting takes effect without a restart, for sessions that open afterwards:

```bash
paseo daemon config set daemon.mcp.injectIntoAgents true
```

Install from one of these sources:

| Source | Command |
|---|---|
| [Plugin directory](https://paseo.sh/plugins), the reviewed version, once the plugin is listed there | `paseo plugin add dutchakdev/secure-input` |
| npm, the newest release, also before the directory has reviewed it | `paseo plugin install npm:paseo-plugin-secure-input` |

`paseo plugin ls` then shows `secure-input` as `running`. `paseo plugin update secure-input` pulls later releases from the same source; `paseo plugin remove secure-input` removes the plugin and leaves its data directory. To run it from a checkout, see [Development](#development).

Link the skill, which tells agents to use the form and how to move a value without reading it. Paseo hands no plugin's skill to agents, and the copy it installs moves to a new directory at every update, so link from a clone. Agents that read `~/.agents/skills` take it from there; Claude Code reads `~/.claude/skills`:

```bash
git clone https://github.com/dutchakdev/paseo-plugin-secure-input.git
cd paseo-plugin-secure-input
mkdir -p ~/.agents/skills ~/.claude/skills
ln -sn "$PWD/skills/secure-input" ~/.agents/skills/secure-input
ln -sn ../../.agents/skills/secure-input ~/.claude/skills/secure-input
```

`ln -sn` replaces nothing: a name that is taken fails with `File exists` or, if it is a real directory, gets the link inside it. Look with `ls -ld` first.

Last, on every device you answer from, open the plugin's settings screen, **Secure input**, and press «Перевірити»: it seals the largest submission one request can carry and has the plugin open it, the way a real value goes.

Answer over the relay or Tailscale. A direct LAN connection with a password is not encrypted ([SECURITY.md](SECURITY.md#the-channel-and-the-versions)).

## How it works

The agent calls `request_secret` with the keys it needs and ends its turn; a pill appears in its chat, and nothing opens by itself. You press the pill, fill in the form, and the app seals the values to a one-time key of the request; the daemon opens them and writes each to `<data>/drop/si-secret-<requestId>/<KEY>`, a file of mode `0600` in a directory of mode `0700`. The agent gets a message with the paths, moves each value by `<` redirection or `cp`, then deletes the directory or calls `release_secret`; the plugin deletes the set anyway, as [Files and when they go](#files-and-when-they-go) says. The form shows no reason: the agent says why it asks in its own message.

## The tools

Paseo serves four tools to every agent that has Paseo's tools, and tells the plugin which agent made each call. An agent sees its own requests only.

| Tool | Input | What it does |
|---|---|---|
| `request_secret` | `reason`, `fields` | Puts a pill in the agent's chat and answers at once with `"status": "pending"`; a message with the paths follows when you have submitted |
| `request_status` | `requestId` | The state, the keys and the `tamper` flag; while the files exist, their paths and when they go. Never a value |
| `cancel_request` | `requestId` | Withdraws the agent's own pending request |
| `release_secret` | `requestId` | Deletes the files of the agent's delivered request now |

A request names at most 32 keys, or none: you can always add keys and files of your own in the form. A key takes a one-line text of at most 64 KiB, or a whole file of at most 128 KiB, binary included, which the app checks as JSON or PEM when the agent asks for that. An agent has one pending request at a time, and a request nobody answers expires after 8 hours. The skill holds the full input and the rules the agent follows.

Checked on Paseo 0.14.0-beta.1 with Claude Code 2.1.311 and Codex 0.164.0. Claude Code lists the tools as `mcp__paseo__request_secret`, `mcp__paseo__request_status`, `mcp__paseo__cancel_request` and `mcp__paseo__release_secret`, deferred: the agent loads one with `ToolSearch` before its first call. Codex has them under the same names, as nested tools of its `exec` tool listed in `ALL_TOOLS`. Paseo's timeline shows a call as `paseo.request_secret`. In Claude Code's `default` mode and Codex's `auto` mode, every call of these tools waits for your permission, and in Claude Code so does each `cp` of a delivered file. Other modes and Kimi were not tried.

## The pill and the form

The pill holds key names, never a value:

| Pill | Meaning |
|---|---|
| «Секрет для агента» and the key, or «Секрети для агента» and how many | Waiting for you. Press it to open the form |
| Green «Передано» | Delivered; the count says how many keys got a file |
| Grey «Передано» | The files are deleted |
| Struck through: «Відхилено», «Скасовано», «Час минув», «Не прийнято» | Declined by you, cancelled by the agent, expired, or refused |
| Red «Підозріле подання» | A second, different submission came after delivery ([SECURITY.md](SECURITY.md#a-hostile-process-that-runs-as-you)) |

The form opens over the chat: a hidden row for each key, with an eye that shows the value. **+** adds a row of your own; in such a row the paperclip makes it a file row, and ✕ removes it. → sends. ✕ at the top declines the request; closing the form any other way declines nothing, and the pill opens it again. The form shows neither the agent's reason nor its labels; a screen reader gets the label. A submission the plugin cannot open counts against the request, which closes after three failed attempts (`retry_limit`). Closing the form throws away what you typed.

### File fields

A JSON key, a PEM, a kubeconfig or a `.p12` comes through a file row, which the agent asks for with `kind` `"file"`; so does a value of several lines, since a text row holds one line.

| | Desktop app | Phone |
|---|---|---|
| Pick a file (the paperclip) | Yes | No: Paseo gives plugins no file picker there |
| Drop a file on the row | Yes | No |
| Paste | Yes | Yes |

Paste opens a text area under the row; when it loses focus, its text becomes the file. The plugin reads no clipboard. The row shows the file's name, its size and, for `json` or `pem`, whether the check passed; never the content. The bytes land in the file on the daemon as they are.

## Files and when they go

Each delivery is a set, `<data>/drop/si-secret-<requestId>/`, with a file for each key you filled in: a text as the UTF-8 you typed, with no newline added; a file field's file byte for byte. The set is built under a temporary name and renamed into place. It is deleted at the first of these:

| Event | What the agent is told |
|---|---|
| The agent calls `release_secret`, or deletes the directory itself | Nothing |
| The end, with any outcome, of the agent's turn that its delivery message starts | Nothing more |
| 15 minutes after the write; on a machine that slept through that, within a minute of waking | If its delivery message is still waiting: that the files were deleted, instead of their paths |
| The plugin starts: everything in `drop/` goes | The same |
| The plugin stops: everything in `drop/` goes | The same |
| You press «Видалити всі файли секретів зараз» in the settings | The same |

An agent busy for more than 15 minutes after you submit loses the files at their deadline and, once idle, is told to ask again. Deletion is `unlink` and `rmdir`, follows no link, and overwrites nothing first; [SECURITY.md](SECURITY.md#what-the-plugin-cannot-control) says why.

The data directory is `${PASEO_HOME:-~/.paseo}/secure-input`: `requests.json` (the requests, their states and key names; no value), `outbox.json` (messages waiting for a busy agent) and `drop/`. The plugin never deletes it, and `paseo plugin remove` leaves it too. Its log, `paseo plugin logs secure-input`, holds codes and fixed phrases only.

## The settings screen

**Secure input**, in the plugin's settings, shows the version and three parts.

- **«Шифрування»**: «Перевірити» seals in the app a dummy payload of the largest size one submission can have, and the plugin opens it: ✓ with the time, or ✗ with what failed.
- **«Стан»** has four rows, read again while the screen is open. «Плагін»: «Працює», «Запускається», or «Не запустився» with the reason. «Секрети на сервері»: how many sets are on the daemon and when the nearest goes; red when something in `drop/` could not be deleted. «Запити, що чекають»: how many wait for you. «Помилки»: the first problem, if any.
- **«Видалити всі файли секретів зараз»**, shown while sets are on the daemon or something in `drop/` could not be deleted. It deletes every set now. «Не вдалося видалити» under it means the plugin refused the deletion as a whole: it is stopping, or `drop/` cannot be swept.

## When something is wrong

| Symptom | Cause and fix |
|---|---|
| The agent says it has no `request_secret` tool | `daemon.mcp.injectIntoAgents` is off ([Install](#install)); the provider's configuration switches Paseo's tools off; or the agent's session opened before the plugin ran. A Codex agent may have to look in `ALL_TOOLS` |
| The agent reports `the plugin did not start (…)` | The start-up failed, and the tools refuse until it succeeds. «Плагін» reads «Не запустився» with the reason, and so does `paseo plugin logs secure-input`: for example a data directory or a `drop/` that is not a private directory of your user. Remove the cause and reload the plugin. `the plugin is busy; retry in a few seconds` is a disk that stalls: nothing was done, and the agent can ask again |
| No pill in the chat, or no **Secure input** screen | The app is older than the plugin requires ([Install](#install)), or the plugin does not run: `paseo plugin ls`, `paseo plugin logs secure-input`. A pill that did not land is tried again once a minute, and «Помилки» shows it meanwhile |
| The agent stops to ask for permission | Claude Code and Codex ask before every call of these tools in the modes that were checked, and Claude Code before each `cp` of a delivered file. Allow it |
| The agent never continued after you submitted | Its message waits until the daemon says the agent is idle; [SECURITY.md](SECURITY.md#crashes-stops-and-restarts) says how long it waits and how it can be lost. Tell the agent to continue: it can call `request_status` |
| «Секрети на сервері» is red | Something in `drop/` could not be deleted; the plugin tries again by itself. Press «Видалити всі файли секретів зараз», or delete `drop/` in the data directory by hand |

## Security

What you enter leaves the app only sealed to a one-time key of the request, and on the daemon it exists in the clear only in those short-lived files, which the plugin shows to nobody. Any process of your OS user can read such a file while it exists, the agent included: what keeps the value out of the model is the skill's rule and the plugin's own silence; nothing locks the file. Which agent asks is the daemon's to say, and on Paseo 0.14.0-beta.1 the daemon does not bind that name to a credential of the agent, so a local process that can reach the daemon can call the tools as another agent: put a request card in that agent's chat, asking you for a secret it never needed, or look at, cancel or release its requests. The plugin cannot tell such a call from the agent's own; the host is where it can be closed. [SECURITY.md](SECURITY.md) has the whole promise and every case where it does not hold.

A rule in your agent's harness that refuses its file-reading tools on paths containing `si-secret-` adds a lock where that harness can enforce one. Leave `cp` and `<` redirection working, or the agent cannot move the value.

## Development

```bash
git clone https://github.com/dutchakdev/paseo-plugin-secure-input.git
cd paseo-plugin-secure-input
npm ci
npm run check                        # typecheck both halves and the tests, then test
paseo plugin install "$PWD"
paseo plugin ls                      # secure-input   running
paseo plugin reload secure-input     # after each edit: source edits are not picked up by themselves
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the tests, the documents they hold to the code, and how a release is cut; [CHANGELOG.md](CHANGELOG.md) lists what each release changed.

## License

MIT, see [LICENSE](LICENSE).
