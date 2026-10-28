secure-input lets an agent ask you for a password, an API key, a token or a whole credentials file through a form in the Paseo app instead of in the chat. The app seals what you enter, the daemon writes each value to a short-lived file that only your OS user can read, and the agent gets only the paths; the skill has it move each file's content without reading it, which holds as far as the agent follows the skill.

## What you see

- **A pill in the agent's chat** for each request, with the key names and never a value. Pressing it opens the form; the agent says why it asks in its own message.
- **The form**: a hidden row for each key, with an eye to show the value, and rows of your own for keys the agent did not name. A file row takes a whole file of up to 128 KiB, binary included: picked or dropped on the desktop, pasted on the desktop and on the phone. ✕ declines the request.
- **The Secure input settings screen**: a check that seals the largest submission one request can carry on this device and has the plugin open it, the plugin's state, and a button that deletes every set of files at once.

The texts of the pill, the form and the settings screen are in Ukrainian only.

## What the agent sees

The agent has four tools, which Paseo serves beside its own: `request_secret` to ask, then `request_status`, `cancel_request` and `release_secret`. A request answers at once that it is pending; once you have submitted, the agent gets a message with the path of each file. No tool result, message, status or log holds a value. The skill that comes with the plugin tells the agent to move each value only by redirection or by copy, and never to read it.

## Setup

- Paseo 0.14.0-beta.1 or later on the daemon and in the app: an older app does not load the pill, the form or the settings screen. A macOS or Linux daemon with Node.js 22.12 or later; live validation has been on macOS.
- Paseo must give its tools to agents (`daemon.mcp.injectIntoAgents`): while that is off, no agent has the plugin's tools.
- Link the skill where your agents read skills, as the [README](https://github.com/dutchakdev/paseo-plugin-secure-input#install) shows.
- Answer from the app over the relay or Tailscale: a direct LAN connection with a password is not encrypted.

## When the files go

The plugin writes directories of mode 0700 with files of mode 0600, one per key you filled in. It tries to delete them when the agent releases the set, at the end of the agent's turn that its message starts, 15 minutes after the write, and at every start and stop of the plugin. A crash or a failed removal can leave files behind until a later attempt succeeds. Deletion does not overwrite their content.

## What it does not protect against

While a file exists, any process of your OS user can read it, the agent included, and on Paseo 0.14.0-beta.1 a local process with access to the daemon can impersonate an agent. What keeps a value out of the model is the skill's rule and the plugin leaving values out of its outputs. [SECURITY.md](https://github.com/dutchakdev/paseo-plugin-secure-input/blob/main/SECURITY.md) describes the threat model and known limitations.
