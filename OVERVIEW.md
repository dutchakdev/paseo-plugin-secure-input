secure-input lets an agent ask you for a password, an API key, a token or a whole credentials file through a form in the Paseo app instead of in the chat. What you enter is sealed in the app, opened on the daemon and written to a set of short-lived files, one for each value, that only your OS user can read. The agent is given the paths, never the values, and moves each value where it belongs without reading it.

## What you see

- **A pill in the agent's chat** for each request, with the key names and never a value. Nothing opens by itself: pressing the pill opens the form, and the agent says why it asks in its own message.
- **The form**: a hidden row for each key the agent asked for, with an eye to show the value, and rows of your own for keys it did not name. A file row takes a whole file of up to 128 KiB, binary included: picked or dropped on the desktop, pasted on the desktop and on the phone. A file the agent asks for as JSON or PEM is checked in the app before anything is sent. ✕ declines the request.
- **The Secure input settings screen**: a check that seals the largest submission one request can carry on this device and has the plugin open it, the plugin's state (the sets on the daemon, the requests that wait for you, the first problem), and a button that deletes every set at once.

The texts of the pill, the form and the settings screen are in Ukrainian only.

## What the agent sees

- The agent has four tools, which Paseo serves beside its own: `request_secret` to ask, then `request_status`, `cancel_request` and `release_secret`. The daemon names the agent that makes each call; nothing the call itself says counts.
- A request answers at once that it is pending. Once you have submitted, the agent gets a message with the path of each file. No tool result, message, status or log holds a value: the agent's model provider gets key names, paths and states, never a value.
- The skill that comes with the plugin tells the agent to move each value only by redirection or by copy, into an `.env` file that git ignores, a file of its own, a tool's stdin or a server, and never to read it.

## Setup

- Paseo 0.14.0-beta.1 or later on the daemon and in the app: an older app does not load the pill, the form or the settings screen. A macOS daemon, where the plugin is developed and run, or a Linux one, where its tests pass, with Node.js 22.12 or later.
- Paseo must give its tools to agents (`daemon.mcp.injectIntoAgents`): while that is off, no agent has the plugin's tools.
- Link the skill where your agents read skills, as the [README](https://github.com/dutchakdev/paseo-plugin-secure-input#install) shows.
- Answer from the app over the relay or Tailscale: a direct LAN connection with a password is not encrypted.

## When the files go

Each delivery is a directory of mode 0700 with a file of mode 0600 for each key you filled in. It is deleted when the agent releases it, at the end of the agent's turn that its message starts, 15 minutes after the write (on a machine that slept, within a minute of waking), and at every start and stop of the plugin; a set that a crash left behind goes at the next start. The files are removed, not overwritten first.

## What it does not protect against

While a file exists, any process of your OS user can read it, the agent included, and on Paseo 0.14.0-beta.1 a process that can reach the daemon's MCP endpoint for agents can ask in another agent's name: what keeps a value out of the model is the skill's rule and the plugin's silence, not a lock. The plugin's SECURITY.md names every case where its promise does not hold.
