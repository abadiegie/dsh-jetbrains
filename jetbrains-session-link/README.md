# Session link

Lets a URL choose the session, so a host that embeds the Web UI — the DSH Companion tool window in a
JetBrains IDE, a script, a bookmark — can ask for a session over the address instead of writing into
the client's own storage.

- `http://127.0.0.1:3080/#dsh-session=session-1e9ac7e1-…` opens that session on load.
- Setting `location.hash = 'dsh-session=session-1e9ac7e1-…'` on an already-open page opens it too,
  through `hashchange`, with no reload.
- The parameter is accepted in the query string as well, and is removed from the address after it is
  honoured, so reloading does not navigate a second time.

The client half draws nothing and registers no slot, so it cannot change how the page looks. It logs
each action to the console, which the IDE plugin already forwards to `idea.log`. The host half is an
empty Loader row: it exists so `client-modules` serves the client bundle.

Install it into a profile with `plugin_manager` (`action: install_bundle`, `target` = this directory);
an open page picks it up through the HMR transport.

## Verified behaviour

Checked end to end in headless Chrome against a running DSH, with the signed cookie and a real
session: setting `location.hash = 'dsh-session=<id>'` on a loaded page opened that session (the page
title became the session's own title), stored it as the client's selection, and cleared the parameter
from the address — with `opened <id> on hashchange` in the console.

Two limits that check exposed:

- A parameter present in the URL of the **first** load can race the client's workspace data, which
  then refuses the open with `sessions.retain: unknown session`. The plugin logs a warning, keeps the
  parameter, and retries on the next hash change or reload; it never fails its own activation. An
  embedding host should set the hash after the page is ready — which is also the reload-free path.
- An open is refused, not queued, when the session is not addressable (unknown, or hidden from the
  client), so a caller that needs certainty should confirm the selection rather than assume it.

## Marker

While it is listening, the plugin sets `window.__dshSessionLink = true`. A host can read that marker
before it decides how to ask for a session: with the marker present the fragment is the reload-free
path, and seeding the client's stored selection instead would reload the page and restart the boot the
fragment is waiting for. The DSH Companion panel uses exactly that check.

## Verified inside the IDE panel

The DSH Companion panel's embedded JCEF browser does engage this plugin. A probe run from the panel
(`DSH_COMPANION_PROBE`, reported into `idea.log`) showed the marker set, the module present in the
page's boot graph, and the ask taking the `linked` branch; the fragment then lost its `dsh-session`
member, which is this plugin's success path, since it clears the parameter only after the client
accepted the open.

What looked like a failure was two other things: the panel's client was showing the session with a
`subagentAddress`, which the panel's own guard (rightly) refuses to treat as the session, and this
plugin reports success with `console.info`, which the panel does not forward to `idea.log`. Fixing the
panel's session resolution to skip delegated children resolved it.
