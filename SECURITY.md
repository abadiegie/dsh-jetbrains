# Security model

These two plugins exist to bridge a local DeepSeek Harness (DSH) and a local JetBrains IDE **on the
same machine, under the same user account**. Everything below assumes that; none of it is designed for
a shared, multi-user, or remote host.

## What the IDE plugin reads

| File | Why | Contains |
|---|---|---|
| `<DSH home>/.credentials.yaml` | To sign the same `dsh-auth-*` browser-session cookie DSH gives a browser, so the plugin can call DSH's HTTP API as you | DSH's `client-connection/browser-session` signing secret |
| `~/.dsh/jetbrains-companion.json` (written by the plugin) | Published workspace descriptor other local processes read | every open project root, the active file and caret, the selected text, open editor tabs, and the loopback bridge **token** |
| `<IDE config>/options/deepseek-harness.xml` | Address/home discovery when you have not configured them | the DSH port and home of an installed DSH IDE plugin |
| `<IDE config>/options/dsh-companion.xml` | The plugin's own settings | URL/home overrides |

The plugin **never writes** the credential document, and it never sends it anywhere: the secret is used
locally to sign a cookie whose audience is the DSH address you configured.

## What any local process of your user can do

- **Read the descriptor** and therefore the bridge token, then call the bridge:
  `GET /health`, `GET /workspace`, and `POST /open` — the last one makes the IDE open a file. Treat the
  token as you treat the credential document: both are readable by anything running as you.
- **Read the credential document** and mint their own DSH session cookie, exactly as this plugin does.
  This is a property of DSH's local design, not something these plugins add.

If that trust boundary is not acceptable for a machine, do not install these plugins there.

## What the chat panel does

- It embeds DSH's own web client in a JCEF browser inside the IDE and puts the signed cookie in that
  browser's cookie store before the first navigation, so the page loads authenticated.
- The cookie is stored in the embedded browser's own profile (per origin, under the IDE's cache
  directory) — not in your system browser, and not in the plugin's settings.
- Console output from that page is forwarded to `idea.log` (warnings and errors) so a failed session
  restoration is diagnosable. It may therefore contain material the page logs, including file paths.

## What the DSH bundle reads

- JetBrains IDE state under the configured configuration roots (default `~/.config/JetBrains`,
  `~/Library/Application Support/JetBrains`, `%APPDATA%\JetBrains`): recent projects,
  `.idea/modules.xml` and the module files it names, `.idea/vcs.xml`, and the per-project workspace
  state — plus, when the companion is running, its descriptor and bridge.
- Nothing outside those roots and the project directories they point at.

## What the DSH bundle can do

- Register DSH workspaces at the window's junction directory (create only — it never deletes a
  registration; pruning is opt-in and refused for a `common-parent` junction).
- Create or attach DSH sessions for a directory. Sessions are never deleted.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the address in `package.json` /
`plugin.xml`. Please do not open a public issue for a vulnerability.
