# Troubleshooting

## The server does not start or does not show up

```sh
opencode mcp list
```

Run the configured command by hand (for example `bunx github:igorovh/multi-cdp-mcp#v0.2.1`). Stderr
shows the reason: an invalid `config.json` names the bad field, and `braveExecutable`
must be renamed to `browser.executable`. Restart OpenCode after changing MCP configuration.

## "No Chromium-based browser found"

Install Chromium, Brave, Edge or Chrome, or set `browser.executable` to the binary. On
Linux the browser must be on `PATH`; Snap and Flatpak builds may need the full path of the
real binary.

## "No caller identity"

The client sent no session ID in `_meta`. OpenCode 2.2.5+ always sends one. For other
clients, pass `callerId: "<session ID>"` on every call, or `environmentId` to address an
environment directly.

## "Environment ... belongs to caller ..."

Another identity owns the environment, for example it was created with `callerId` and
later stopped without it. The error names the owner. Repeat the call with that `callerId`,
or pass `environmentId` to `cdp_environment_stop`. Deleting requires a takeover with
`cdp_environment_select` first.

## Template copy fails or cloned logins are missing

Close the source browser completely before the first copy or before setting
`refreshTemplate: true`. Many sites and Chrome's cookie encryption bind sessions to the
original profile: sign in once inside the environment; stop and resume keep it.

## Extension control is unavailable

`cdp_environment_list` shows `extensionControl` and `extensionControlError`.

- **Google Chrome**: Chrome 137+ ignores `--load-extension`. Use Chromium, Brave or Edge for
  extension work.
- **Other browsers**: the server retries on every extension call and wakes a dormant control
  worker. If it still fails, check `extensions.controlExtensionPath`, read
  `<dataRoot>/logs/browser-<port>.log`, then `cdp_environment_stop` and retry. A browser
  recovered after a server crash keeps the flags it was started with.

## Extensions are disabled after a restart

The server enables developer mode before every launch and re-enables extensions it loaded.
Extensions you disabled with `cdp_extension_set_enabled` stay disabled; enable them again
explicitly. Keep `extensions.materializeProfileExtensions: true` for cloned profiles, and
do not delete `Default/Extensions` inside a profile.

## "cannot be modified by user"

Chromium locks extensions whose cloned install record it does not trust. Load the
extension's directory through `devExtensionPaths` in a new environment.
`cdp_extension_list` marks such extensions `controllable: false` with a `lockedReason`.

## `install_extension` says "Access denied"

The backend only reads inside its roots: the OS temp directory, `devExtensionPaths` and
`backend.filesystemRoots`. See [`CONFIGURATION.md`](./CONFIGURATION.md).

## Timeouts and background tabs

Hidden tabs throttle timers and `requestAnimationFrame`. Pass `bringToFront: true` to
`evaluate_script`, `click` or `hover`, and keep in-page waits short. A navigation timeout
returns the page's URL and `readyState`; the page has usually loaded.

## Environment is locked

A running server owns that profile. Do not delete the lock or open the profile directory
in another browser. After a crash, the next server proves the recorded PID is dead and
takes over the stale lock.

## Port is unavailable

Widen `browser.portRange` or stop whatever uses the port. The server never attaches to an
unknown browser just because it answers on a saved port.

## Collect diagnostics

Set `MULTI_CDP_MCP_VERBOSE=1`, reproduce once, then check:

- `<dataRoot>/logs/browser-<port>.log`
- `<dataRoot>/logs/backend-<environment>.log`
- the MCP client's own log (OpenCode: `~/.local/share/opencode/log/`)

Do not share cookies, authorization headers, profile files or private screenshots.
