# Troubleshooting

## OpenCode does not show the server

```powershell
opencode mcp list
```

Confirm the command's `cwd` points at this repository and that `bun run start` works from
that directory. OpenCode prefixes/group tools with the normalized server name
(`multi-cdp`). Restart the OpenCode service after changing MCP configuration when your
installed CLI provides service management:

```powershell
opencode service restart
opencode service status
```

If `opencode service` is unavailable, close and reopen the OpenCode TUI/application. Use
`opencode mcp list` to verify the reloaded configuration.

## Template copy fails or cloned logins are stale

Close every Brave window and verify no `brave.exe` remains before setting
`refreshTemplate: true`. Keep it `false` during normal proxy starts.

Website sessions can expire or be revoked server-side. A one-time login inside a persistent
environment is retained across stop/resume even when the original session did not clone.

## "No caller identity"

The client sent no `_meta.sessionID` (OpenCode Code Mode `execute` currently does not; see
[`opencode-upstream.md`](./opencode-upstream.md)). Pass `callerId: "<session ID>"` on every
call, or `environmentId` to address an environment directly.

## "Environment ... belongs to caller ..."

The environment was bound under another identity, for example created with `callerId`
and later stopped without it. The error names the owner. Repeat the call with that
`callerId`, or pass `environmentId` explicitly to `cdp_environment_stop`. Deletion requires
a takeover with `cdp_environment_select` first.

## Extensions disappear after a restart

Keep `extensions.materializeProfileExtensions: true`. See finding 2 in
[`findings.md`](./findings.md). After the first launch Chromium no longer stores the
manifest in `Secure Preferences`; the proxy then finds each extension through the `key`
it wrote into `Default\Extensions\<id>\<version>\manifest.json`. Deleting those
directories makes recovery impossible.

## "cannot be modified by user"

Chromium locks an extension whose cloned install record it does not trust; this affected
"Load unpacked" builds inherited from the template. New starts reload those builds through
`--load-extension`, which makes them controllable. `cdp_extension_list` reports
`controllable: false` and a `lockedReason` for anything still locked.

## Enable/disable says control is unavailable

The error and `cdp_environment_list` (`extensionControl`, `extensionControlError`) give
the reason. The proxy retries the attach on every extension call and wakes a dormant
control worker by opening its page. If it still fails, check that
`extensions.controlExtensionPath` points to `extensions\control`, inspect
`brave-<port>.log` under `<dataRoot>\logs`, then `cdp_environment_stop` and retry; a
browser recovered after a proxy crash keeps the flags it was launched with.

## `install_extension` says "Access denied"

The backend only reads paths under its roots; see "Paths readable by `install_extension`"
in [`CONFIGURATION.md`](./CONFIGURATION.md). It is deterministic: OS-temp paths work, other
paths need `backend.filesystemRoots` or the environment's `devExtensionPaths`.

## Timeouts and background tabs

Hidden tabs throttle timers and `requestAnimationFrame`. Pass `bringToFront: true` to
`evaluate_script`, `click` or `hover`, and keep in-page waits short. `evaluate_script`
accepts `timeout` (ms). A navigation timeout returns the page's current URL and
`readyState`; the page has usually loaded.

## Environment is locked

A live proxy owns that profile. Do not delete the lock or open the same directory manually.
If a proxy crashed, the next proxy automatically proves the recorded PID is dead and takes
over the stale lock.

## Port is unavailable

Expand `browser.portRange` or stop the process using that port. The proxy never attaches to
an unknown process merely because it responds on a saved port.

## Collect diagnostics

Set `MULTI_CDP_MCP_VERBOSE=1`, reproduce once, then inspect:

- `<dataRoot>\logs\brave-<port>.log`
- `<dataRoot>\logs\backend-<environment>.log`
- OpenCode: `~/.local/share/opencode/log/opencode.log`

Do not share cookies, authorization headers, profile files or private screenshots.
