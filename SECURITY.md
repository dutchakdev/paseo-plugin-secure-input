# Security

## What this plugin promises

Over the relay or Tailscale, with an honest but careless agent:

- **On its way, a value is sealed.** What you type, pick, drop or paste leaves the app only as ciphertext, sealed to a one-time key of the request (X25519, HKDF-SHA256, ChaCha20-Poly1305) and bound to the request's id and to a digest of the keys it declared and whether each is optional. A file travels as base64url inside the same sealed payload. If sealing fails, nothing is sent.
- **On the daemon, a value is a short-lived file.** On disk it exists in the clear only under `drop/`: as `<data>/drop/si-secret-<requestId>/<KEY>`, a file of mode `0600` in a directory of mode `0700`, or, after a failed write, under a temporary name there. The plugin deletes a set 15 minutes after the write at the latest while the machine is awake, and within a minute of waking when it slept through that; earlier when the agent releases it, at the end of the turn its delivery message starts, and at every start and stop of the plugin. A crash, a stalled disk or a failed removal can keep it longer ([below](#crashes-stops-and-restarts)).
- **Outputs and metadata.** No tool result, message to the agent, pill, status, RPC answer, log line, error, `requests.json` or `outbox.json` holds a value; the agent is given paths. Plaintext also exists for a while in app and daemon memory (below).
- **The daemon names who asks.** A request belongs to the agent identity Paseo supplies with the tool call; nothing the call itself says is read. Of the four tools, status, cancel and release answer any other agent, its parent included, as if the request did not exist. On Paseo 0.14.0-beta.1 a local process with access to the daemon can impersonate an agent ([below](#a-hostile-process-that-runs-as-you)); the plugin cannot verify that the named agent made the call.

While a file of a set exists, any process of your OS user can read it, the agent included. What keeps the value out of the model is the agent's discipline (the skill: never read a `si-secret-` path) and the plugin leaving values out of its outputs.

## When it does not hold

The plugin flags one thing: a second, different submission to a request whose values were delivered is refused, marked on the pill and reported to the agent. Beyond that it neither prevents nor detects what a process that runs as you does.

### What the plugin cannot control

| Condition | What happens |
|---|---|
| The agent reads a file of the set | The value enters its context. The skill forbids it and the delivery message repeats it. A rule in the agent's harness that refuses its file-reading tools on `si-secret-` paths blocks accidental reads through those tools only, not reads through the shell or from the destination |
| The agent feeds the value to a command that prints it | The value reaches the model through that output: a tool that echoes what it stored, a verbose flag, `set -x`, an argument repeated in an error. The skill lists moves that print nothing |
| Another process of your user reads the file while it exists | Nothing stops it. The modes keep out other users only, and every agent of yours runs as you |
| The file system copies on write, or a snapshot or a backup runs while the file exists | Deletion is `unlink` and `rmdir`; the content is not overwritten first, since on APFS, Btrfs or ZFS overwriting guarantees nothing. The blocks stay on the disk until they are reused, and a snapshot or a backup taken meanwhile keeps the file |
| A value is held in memory | Byte buffers are wiped in the app and on the daemon; the strings made from them cannot be. What you type is a string in the form while it is open, and the opened values are strings on the daemon until the garbage collector reuses their memory |
| You paste into a file row, or pick or drop a file | The plugin reads no clipboard and moves no file: what you copied stays in your clipboard and its history, and the file stays where it was. While the paste area is open, what you pasted is on the screen |
| The value reaches its destination | Where the agent puts it is outside the plugin. Whether that place is ignored by git, backed up or readable by others is for the agent and you to check |
| You answer a harmful request | The form does not assess whether a request is safe. Check the intended task and destination before submitting |

### A hostile process that runs as you

An agent with a shell runs as your OS user, controls its workspace, and can read and write the plugin's data directory. Nothing here prevents what such a process does.

| Condition | What happens |
|---|---|
| A process impersonates an agent | On Paseo 0.14.0-beta.1 a local process with access to the daemon can call the tools as another agent: create a request, and its pill, in that agent's chat, a card that asks you for a secret on behalf of an agent that never asked; and look at, cancel or release that agent's requests. The plugin cannot verify that the named agent made the call; only Paseo can close this. Provide a secret only for a task and destination you recognise |
| Any owner session of the daemon calls the plugin's RPCs; automated callers can use them too | A handler is not told who is calling, so an RPC call does not prove that you approved the request. Such a caller can read a request's view (its keys, labels and public key; never a value), submit its own values before you do, decline a request, or send three submissions that cannot be opened and so close it (`retry_limit`). If it submits first, the files hold its values; your own submission is then refused, the pill turns red, «Підозріле подання», and the agent is told to have you check what it did with the values and to rotate the secret |
| A caller of `secure-input.drop.clear` | Deletes every set at once, as «Видалити всі файли секретів зараз» does. Agents lose the files they had not moved yet, and one whose delivery message still waits is told that the user deleted them. The RPC returns counts of released requests and remaining entries |
| A process plants `requests.json` or `outbox.json` | Both are read as hostile input: capped, never through a link, and entry by entry against a strict schema with no field a value could go into. A planted outbox entry can at most make the plugin send one of its fixed messages again, to the agent whose request it names, once per restart. A planted record that passes the schema is loaded; one that claims to wait or to be delivered is ended by the next start (`expired`, or `released` by `restart`), with a pill of its key names in the chat of the agent it names. Nothing can be opened or written for it: the key never existed in this run |
| A process plants entries or links in `drop/` | The start's sweep removes everything in `drop/`. A link is unlinked as a link and never followed, and removal goes at most 8 levels deep; what is deeper is left and reported. A `drop/` that is itself a link, or not a directory of your user, fails the start-up; put in its place while the plugin runs, it is refused by every write and every removal, and what was to go stays reported until it can go. Anything at a set's path but an empty directory fails that write (`write_failed`) |
| A process swaps a directory for a link in the instant before a removal | Node has no `unlinkat` or `openat`, so every removal goes by path. Before each entry the plugin looks at the entry's directory again and goes on only if it is still the directory it read (the same device and inode); `drop/` itself is held to this too. A swap that lands between that look and the call it guards is not caught: an `unlink` then removes a file of that name wherever the link leads, and a directory's removal goes on where the link leads, at most 8 levels deep. A write holds `drop/` when it begins and looks at it again right before the rename that puts the set in place. A process that can win these races can read or delete what they reach by itself |
| The data directory is inside a workspace (`PASEO_HOME` there) | The sets are files in that workspace while they exist, and `git add -A` there can stage one. The plugin does not check where its data directory lies |
| `bin/`, where 0.1.0 was installed | It holds what agents created with 0.1.0 run: a stub with no tools, and the shim that starts it. A process of your user can replace them between two starts, as it can the plugin's own code. Each start writes the stub again, and under Node the shim too; under Electron the shim stays as 0.1.0 wrote it |

### Crashes, stops and restarts

| Condition | What happens |
|---|---|
| The plugin or the daemon is killed, or the machine loses power, while a set exists | The set stays in `drop/` until the plugin next starts: while it does not run, nothing deletes the set, not even 15 minutes after the write. A start sweeps `drop/` first, once it has made sure the data directory is its own and before anything else that can fail. What the sweep cannot remove is reported, and each such entry is tried again once a minute until it goes; the sweep itself is not repeated, since it would take the sets delivered since. A plugin that never starts again leaves the set where it is |
| The plugin is stopped | Paseo 0.14 gives a stopping plugin 2 seconds before it sends SIGTERM. Within them the plugin wipes the keys of the requests that wait, releases every set as `stop`, saves, and sweeps `drop/`: the releases and the save get at most 1 second, and the sweep after them at most 500 milliseconds, whatever the work queue is still doing. What the sweep cannot remove in that time stays for the next start. A record whose release the stop could not save reads `restart` at the next start |
| The stop comes while the start-up hangs (a disk that stalls) | The stop waits up to 5 seconds for the start-up, longer than the 2 seconds Paseo gives the stop, and then goes on without it. Such a start-up has delivered no set, since every tool call waits for the start-up, so what can be cut short is only the sweep of what an earlier run left, which the next start makes |
| A write fails, and its clean-up cannot remove what it staged | The request is rejected (`write_failed`), and the half-written set stays in `drop/` under its temporary name, `si-secret-<requestId>.<random>.tmp`. «Секрети на сервері» turns red, and the entry is tried again once a minute until it goes; the stop, the next start and «Видалити всі файли секретів зараз» take it too. Nobody is given its path |
| A removal fails | The request stays `delivered` and «Секрети на сервері» turns red. A delivered set is tried again at its deadline, and after that once a minute; the end of a later delivery turn of its agent tries sooner. What a start or a failed write left is tried again once a minute. «Видалити всі файли секретів зараз» tries again now; so does deleting `drop/` by hand |
| A disk that stalls holds up the plugin's work queue | Every deletion but the stop's sweep waits in that queue, the deadline's included, so for as long as the disk stalls a set can outlive its deadline. A tool call waits there for its turn for at most 10 seconds and is then refused, `the plugin is busy; retry in a few seconds`; what it asked for is not done later. An operation that has begun is waited for to the end |
| The plugin restarts while a request waits for you | The request becomes `expired`, because the key to open it lived in memory only. The agent is told that the restart ended it |
| The plugin restarts while a set exists | The start's sweep removes it, and the request reads `released` (`restart`). A delivery message that still waits becomes the message that the files went when the plugin restarted; one already sent is not sent again. A set the sweep cannot remove keeps its request `delivered`, and «Секрети на сервері» red, until it goes; a delivery message that goes out meanwhile gives the paths of the files that are still there |
| A message to the agent is late or lost | A message for a busy agent waits for the agent to become idle, within the bounds below; a failed or unanswered idle check leaves it waiting. The plugin checks that the agent is idle and then sends, so a turn that starts between the two can be interrupted. Each send is attempted at most once; a message can be lost when the plugin dies before it was saved, or dies or is stopped between taking it out of `outbox.json` and the end of the send; when the send fails or is not answered in time; when it waited past the queue's age or count limit, or the clock was set back while it waited; when the agent is archived; when the plugin no longer has the request it is about (`requests.json` unreadable at a start, or the request evicted from the history); when a stop ran out of its time before the change of state was saved; or when `outbox.json` was replaced by something the plugin did not write. A message about delivered files is not sent at all when the agent released those files first. The agent may then need a nudge from you |
| The plugin is stopped while messages or pills wait | No further pill is put on a timeline, and no agent is asked whether it is idle. A message that was not sent stays in `outbox.json` for the next start. A change of state whose save was still under way when the stop ran out of its time is saved and announced by nobody: no message for it, and the pill goes on showing the state before it. The form behind the pill shows the true state |
| A pill cannot be put on the agent's timeline | The pill is the only way to the form, so it is tried again once a minute and whenever the daemon next calls the plugin, until it lands, and only once in five minutes while the daemon has left three appends of it unanswered. Until then nobody can answer the request |
| The plugin is removed, or never starts again | What the next start would have swept stays in `drop/`: the sets of a run that was killed, and what a failed write left. Nothing else of the plugin's holds a value |

The bounds of the message queue:

| Bound | Value |
|---|---|
| How long a message waits for an idle agent | up to a day; the outbox holds 256 messages, and the oldest go first |
| A clock set back while a message waits | by more than a minute: the message goes |
| How long a request is remembered | the last 200 closed requests, or fewer when `requests.json` would exceed 2 MiB; open requests are never evicted |
| The idle check and the send | the plugin asks once a minute; one call may take 30 seconds, one round 45 seconds, and 1 second once the round's time is used up |

### The channel and the versions

| Condition | What happens |
|---|---|
| A direct LAN connection with a password | The WebSocket is not encrypted. An active attacker can swap the request's key and read what you type. Enter secrets over the relay or Tailscale only |
| Someone sees the size of what you send | The sealed submission is padded to a multiple of 1 KiB. An observer can still infer a size range, and for a request with one value the approximate length of that value |
| The app is older than the plugin requires (0.14.0-beta.1) | The plugin runs on the daemon, but the pill, the form and the settings screen do not load, so that device cannot answer requests. `paseo plugin ls` does not show it |
| The reply to your submission is lost, and you press → again with other values | The form first reads the request again, and sends nothing if the request has been answered. That narrows the window: a first submission still waiting in the plugin can win after that reading, and your second one is then refused and flagged as a second, different submission, though both were yours. With unchanged values the form sends the same sealed data again, which is never flagged |
| Linux | Developed and run on macOS. Linux is declared supported, and the test suite passes on it; the plugin has not been run on a Linux daemon |

## Reporting

Report a vulnerability privately, through GitHub's private vulnerability reporting on [dutchakdev/paseo-plugin-secure-input](https://github.com/dutchakdev/paseo-plugin-secure-input): the **Security** tab, then **Report a vulnerability**. Do not open a public issue for it, and do not include real secrets in a report: use test values, and leave out the content of any `si-secret-` file.
