---
name: secure-input
description: Use when a task needs a secret from the human — a password, API key, token, private key, credentials file or connection string with credentials — or when you are about to tell the user to paste, export or type such a value themselves. Opens a secure form in the Paseo app; each value or file arrives as a short-lived file whose path you get, and you move it where it belongs without ever reading it.
---

# Secure input

When you need a secret, make a request instead of asking in chat. The user fills in a form in the Paseo app, each value lands in a short-lived file that only your OS user can read, and you get its path. You move the value where it belongs without reading it, then delete the file.

## Hard rules

- **Never ask for a secret in chat.** Not "paste it here", not "export it and tell me", not "put it in `.env` yourself". Make a request.
- **Never let a `si-secret-` file's content reach you.** Never read, print, open, compare, hash, measure or log a file or directory whose name starts with `si-secret-`, and never pass its content as an argument: no `cat PATH`, `head`, `less`, `grep`, `diff`, `wc`, `xxd`, `base64`, no editor or file viewer, and no `ls -l` of its files. Such a path may stand in a command only after `<`, as the source of `cp`, or after `rm -r`: a value moves by redirection or by copy, and a command that reads it from its stdin into its destination, `cat` included, moves it blind.
- **Move, then delete or release.** Move every value in the turn the message starts. Then delete the directory, as the message shows, or call `release_secret`. At the end of that turn the plugin deletes the files anyway.
- **Do not poll.** A request answers `End your turn now. You will receive a message when the user has submitted. Do not poll.` Do that. Call `request_status` once, and only when the user says they submitted and no message came, or that no form appeared.
- **Say the reason yourself.** The form shows neither your reason nor your labels. In your own message, tell the user what you need, why, and that the form opens from the pill in this chat.
- **A plugin that is down is no reason to take a secret in chat.** When the tool is missing, or keeps answering `service_unavailable`, tell the user and stop.
- **One pending request at a time.** Ask for every value a task needs in a single request.

## Asking

The tool is `request_secret`, and its full name depends on your harness:

- Claude Code: `mcp__paseo__request_secret`, deferred. Load it with `ToolSearch` (`select:mcp__paseo__request_secret`) before the first call; the other three load the same way.
- Codex: a nested tool of `exec`. Find it in `ALL_TOOLS` and call `tools.mcp__paseo__request_secret(…)`.
- Elsewhere, look for a tool whose name ends in `request_secret`.

If there is none, this session cannot use the plugin: tell the user, and do not ask for the secret in chat. Your harness may ask the user to allow each call of these tools; that is expected.

The input is `{ reason, fields }`, each field `{ key, label?, optional?, kind?, format? }`:

- `reason`: one sentence, at most 300 characters. It is kept with the request and shown nowhere.
- `label`: at most 80 characters. A screen reader reads it with its field, a text or a file; it is not shown.
- `key`: `[A-Za-z_][A-Za-z0-9_]*`, at most 128 characters, not `__proto__`, `constructor` or `prototype`. It becomes the file's name, so keys that differ only in letter case are refused.
- `kind`: `"text"` (the default) for one line, such as a token or a password, at most 64 KiB; `"file"` for a whole file, such as a JSON key, a PEM, a kubeconfig or a `.p12`, at most 128 KiB, binary included.
- `format`: for a file only. `"json"` or `"pem"` is checked in the app; `"any"` (the default) is not.
- `optional`: the user may leave it empty, and it then gets no file.
- At most 32 fields, or none. The user can always add keys and files of their own.

One key:

```json
{ "reason": "OpenAI key for the summariser's integration tests", "fields": [{ "key": "OPENAI_API_KEY" }] }
```

Several, one of them optional:

```json
{
  "reason": "Stripe test keys for the checkout tests",
  "fields": [
    { "key": "STRIPE_KEY", "label": "Secret key, starts with sk_test_" },
    { "key": "STRIPE_WEBHOOK_SECRET", "optional": true }
  ]
}
```

A whole file:

```json
{ "reason": "GCP service account for the deploy script", "fields": [{ "key": "GCP_SA", "kind": "file", "format": "json" }] }
```

No keys, when you do not know their names. The user adds each key and its value:

```json
{ "reason": "Credentials for the staging database", "fields": [] }
```

## Moving a value blind

Each path in the delivery message is already quoted for a shell: use it as it stands (`PATH` below). A path from `request_status` (`files`) is not: it is the path as it is, and may hold spaces or an apostrophe. Quote it yourself before a shell sees it, in single quotes, each `'` in it written as `'\''`. Run every move before your turn ends.

**Into `.env`**, as one line `KEY=value`, into a file that git does not track and only your user can read, with nothing printed:

```sh
{ ! git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git check-ignore -q .env.local; } &&
  ( umask 077; touch .env.local ) && chmod 600 .env.local &&
  { printf '\nSTRIPE_KEY='; cat; printf '\n'; } < PATH >> .env.local
```

The first line goes on only outside a git repository, or when git ignores the file. When it stops there, nothing is written: ask the user where the value may go, and never add the file to git. The second line makes the file private: a new one is created `0600`, one that is there already is set to `0600`. The path stands only after `<`, and the output goes only into the file. The leading newline starts a line of its own even when the file does not end with one. The value goes in as typed, so a reader that treats `#`, quotes or spaces specially may read it differently. To learn whether the key is already there, count it by name, `grep -c '^STRIPE_KEY=' .env.local`, never by any part of a value; to replace it, ask the user. A value of several lines (a PEM, a JSON key) has no safe form on one `.env` line: ask for it as a file field and give it a file of its own, next.

**A whole file:**

```sh
cp PATH config/gcp-sa.json && chmod 600 config/gcp-sa.json
```

`cp` keeps the mode of a destination that already existed, hence the `chmod`. Inside a git repository, make sure the destination is ignored first (`git check-ignore -q config/gcp-sa.json` succeeds), and never stage it.

**On stdin**, to a tool that reads its secret there:

```sh
gh secret set STRIPE_KEY < PATH
docker login --username USER --password-stdin REGISTRY < PATH
```

**To a remote server:**

```sh
ssh HOST 'umask 077; mkdir -p ~/.config/app && touch ~/.config/app/token && chmod 600 ~/.config/app/token && cat > ~/.config/app/token' < PATH
```

`umask 077` makes a new file private; `chmod 600` makes one that was there already private too.

**A credentials file a tool reads by path.** Copy it where it will stay, as above, and point the tool at the copy by its absolute path (`GOOGLE_APPLICATION_CREDENTIALS`, `KUBECONFIG`, a config file). Never point anything at the `si-secret-` path: it is gone at the end of the turn.

**Not blind**, so never:

- anything that shows the file: `cat PATH`, `echo "$(cat PATH)"`, an editor or a file viewer;
- the value as an argument (`--password "$(cat PATH)"`): other processes see arguments, and a tool may repeat them in an error;
- `export TOKEN="$(cat PATH)"`: every later command inherits it, and `env` prints it;
- a command that echoes what it stored, a verbose flag, `set -x`: read the tool's help first;
- comparing, counting or hashing the value (`diff`, `grep`, `wc -c`, `shasum`): each tells you something about it.

## What comes back

| You receive | Meaning | Do |
|---|---|---|
| `"status": "pending"` | The form is waiting for the user | End your turn |
| `… delivered N value(s) as files only your OS user can read:`, then `KEY → <path>` for each file | The values are files now | Move each one in this turn, then delete the directory as the message shows, or call `release_secret`. A key you did not ask for is one the user added: ask what it is for, without opening it |
| `Left empty by the user, so no file: …` | Optional keys the user left empty | Carry on without them |
| `… was delivered, but its files were deleted 15 minutes after they were written, …` | The files went before this message reached you | If the values are still needed, make a new request |
| `… deleted when the plugin restarted, …` | As above: the plugin restarted | The same |
| `… deleted when the plugin stopped, …` | As above: the plugin stopped | The same |
| `… deleted by the user, …` | As above: the user deleted every file in the plugin's settings | Ask the user before you ask again |
| `… was rejected before any file was written (code). …` | Nothing was written | If it ends `Fix the cause and make a new request.`, do that. If it ends `Tell the user what happened. Do not make a new request yourself; …`, tell the user and stop |
| `…: the user declined to provide the values.` | The user said no | Ask how they want to proceed; do not rephrase and retry |
| `… expired before the user answered.` | Nobody answered in 8 hours | Ask again if the values are still needed |
| `… expired when the plugin restarted. Nothing was delivered.` | The plugin restarted before the user submitted | Ask again if the values are still needed |
| `Warning for request …: a second, different submission arrived after the values were delivered.` | Someone may have submitted before the user: the files may not have held what the user typed | Tell the user what you did with the values, and that the secret should be rotated |

`request_status` gives `state`, `keys`, `written`, `tamper` and `errorCode`, and while the files exist, `files` (key → path) and `deleteBy`. Never a value. If it says `delivered`, move the files at those paths as you would from the message, each quoted for the shell first, as above. If it says `pending`, the form is still waiting: the user has not submitted, or the form refused what they sent and shows why. Either way the pill in this chat opens it; do not cancel and ask again, or the user types everything twice.

Nothing comes when the files go the ordinary way: when you delete them or call `release_secret`, or at the end of your turn. A request you cancel ends without a message.

## When a request is refused at once

The tool answers with an error whose text is `{"error": "<code>", "message": "<code>: <detail>"}`.

| `error` | Do |
|---|---|
| `invalid_request` | The message says what is wrong. A member of your request: fix it. `unknown request`: the id is not one of your requests. `the request has no files to release`: it was never delivered |
| `request_already_pending` | The message is the id of your pending request. Wait for it. `cancel_request` it only when its values are no longer needed, never to make room for a new request: the user would type everything again |
| `request_closed` | `cancel_request` on a request that no longer waits. `request_status` shows its state |
| `service_unavailable` | `the plugin has not finished starting; retry in a few seconds`: retry, twice at most. `the plugin is busy; retry in a few seconds`: nothing of the call was done; retry, twice at most, then tell the user. `the plugin did not start (…). Tell the user. Do not ask for the secret in chat instead.`: do that. `the plugin is shutting down`: tell the user. `the request could not be handled`: the plugin failed over the call; ask once more, and if that answers `request_already_pending`, wait for that request |
| `write_failed` | From `release_secret`: `the files could not be deleted; the plugin tries again`. Tell the user; do not call it in a loop |
