# Troubleshooting

## OpenCode does not show the server

```powershell
opencode mcp list
```

Confirm the command's `cwd` points at this repository and that `bun run start` works from
that directory. OpenCode prefixes/group tools with the normalized server name
(`multi-cdp`). Restart the OpenCode service after changing MCP configuration:

```powershell
opencode service restart
opencode service status
```

## Template copy fails or cloned logins are stale

Close every Brave window and verify no `brave.exe` remains before setting
`refreshTemplate: true`. Keep it `false` during normal proxy starts.

Website sessions can expire or be revoked server-side. A one-time login inside a persistent
environment is retained across stop/resume even when the original session did not clone.

## Extensions disappear after the first restart

Keep `extensions.materializeProfileExtensions: true`. See finding 2 in
[`findings.md`](./findings.md). Deleting extension paths from `Secure Preferences` or from
the profile's `Default\Extensions` directory makes materialization impossible.

## Enable/disable says control is unavailable

Check that `extensions.controlExtensionPath` points to `extensions\control` and inspect the
corresponding `brave-<port>.log` under `<dataRoot>\logs`. Brave must be launched with the
control directory in `--load-extension`.

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
