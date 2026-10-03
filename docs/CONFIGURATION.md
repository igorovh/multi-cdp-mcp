# Configuration

The proxy reads JSON from `%LOCALAPPDATA%\multi-cdp-mcp\config.json`. Override the path
with `MULTI_CDP_MCP_CONFIG`. Missing fields inherit defaults from `src/config.ts`.

## Profile source

```json
{
  "profileSource": {
    "mode": "clone",
    "sourceUserDataDir": "C:\\...\\Brave-Browser\\User Data",
    "refreshTemplate": false,
    "maxTemplateSizeGb": 5
  }
}
```

- `clone`: if no template exists, copy the complete Brave user-data root while Brave is
  closed. With `refreshTemplate: false`, later proxy starts reuse it.
- `fresh`: create an empty template. Existing environment profiles are never overwritten.
- `template`: fail unless `<dataRoot>\templates\default` already exists.

Template changes affect future environments only. Stop/resume never recreates a profile.

## Extensions

```json
{
  "extensions": {
    "controlExtensionPath": "E:\\multi-cdp-mcp\\extensions\\control",
    "devExtensionPaths": ["E:\\extension-worktree\\dist"],
    "materializeProfileExtensions": true
  }
}
```

`materializeProfileExtensions` must stay enabled for cloned Brave profiles. Chromium
otherwise removes copied Web Store extension install records after the first launch. The
proxy loads those directories as unpacked extensions with their original public keys, so
their IDs and storage origins remain stable.

Use `cdp_environment_create.devExtensionPaths` when different environments should load
different worktree builds.

Template extensions installed with "Load unpacked" (for example a local `dist` build) are
reloaded through `--load-extension` as well, because their cloned install records are
locked by Chromium. A `devExtensionPaths` build with the same manifest `name` replaces the
template build in that environment.

## Paths readable by `install_extension`

`chrome-devtools-mcp` only accepts paths inside its workspace roots. The proxy passes:

1. `<dataRoot>\artifacts\<environment-id>` (screenshots, traces);
2. the OS temp directory (always allowed by the backend);
3. `extensions.devExtensionPaths` and the environment's own `devExtensionPaths`;
4. `backend.filesystemRoots`.

Both sides are compared after `realpath`, so the result is deterministic. A junction that
points outside a root (for example a worktree directory linked to another drive) is
rejected; add its real target instead.

```json
{
  "backend": {
    "filesystemRoots": ["E:\\Projekty\\WebstormProjects"],
    "compactToolSchemas": true
  }
}
```

`compactToolSchemas` shortens downstream descriptions to their first sentence.

## Browser and limits

`browser.portRange` is local-only and one port is reserved atomically per running
environment. `limits.maxEnvironments` limits concurrently starting/running environments;
stopped profiles do not consume a slot.

`limits.toolTimeoutMs` (default 150 s) bounds every proxy-to-backend call and stays below
Puppeteer's fixed 180 s `protocolTimeout`, which `chrome-devtools-mcp` does not expose.
`evaluate_script` also gets an in-page time limit (its `timeout` argument, default
`toolTimeoutMs - 20 s`, max 170 s), so a stuck script ends instead of holding the backend.
`limits.navigationTimeoutMs` (default 30 s) applies to `navigate_page`/`new_page` when no
`timeout` is passed.

`browser.headless` defaults to `true`. Agents can override it per environment with
`cdp_environment_create({ headless: false })`; the choice is persisted with that profile.

Diagnostics go only to stderr. Set `MULTI_CDP_MCP_VERBOSE=1` for debug messages; stdout
is reserved for MCP stdio frames.

## OpenCode V2

Project-local configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "multi-cdp": {
        "type": "local",
        "command": ["bun", "run", "src/index.ts"],
        "cwd": ".",
        "codemode": true,
        "protocol": "legacy",
        "timeout": {
          "startup": 60000,
          "catalog": 30000,
          "execution": 600000
        }
      }
    }
  }
}
```

### Caller identity

The server runs over stdio, so there are no request headers and no transport session ID.
The only per-call identity is in the request. Precedence:

1. `_meta.sessionID` (also `_meta.sessionId`, `_meta["opencode/sessionID"]`);
2. the `callerId` argument;
3. the transport session ID (only for session-aware transports);
4. `explicit:<environmentId>` when only `environmentId` is passed, or
   `explicit:<name>` for `cdp_environment_create` with a `name`.

Direct OpenCode tool calls send `_meta.sessionID`. Calls made through Code Mode `execute`
currently do not (see [`opencode-upstream.md`](./opencode-upstream.md)); pass `callerId`
there. `cdp_environment_list` needs no identity. The proxy never falls back to one
implicit global browser.

Calls with an explicit `environmentId` and no other identity are routed to that environment
without changing its binding. `cdp_environment_stop` with an explicit `environmentId` works
for any idle environment, because stopping keeps the profile. Deletion still requires the
owner, or a takeover with `cdp_environment_select` first.
