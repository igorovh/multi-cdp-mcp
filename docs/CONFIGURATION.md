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

## Browser and limits

`browser.portRange` is local-only and one port is reserved atomically per running
environment. `limits.maxEnvironments` limits concurrently starting/running environments;
stopped profiles do not consume a slot.

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

OpenCode V2 sends the invoking session as `_meta.sessionID` for both direct and Code Mode
calls. Other MCP clients pass `callerId` to management tools and can pass the optional
`environmentId` exposed on downstream and extension tools. The proxy never falls back to
one implicit global browser when caller identity is absent.
