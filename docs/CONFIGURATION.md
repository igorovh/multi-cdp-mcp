# Configuration

The server reads one JSON file. Missing fields use the defaults in `src/config.ts`. Unknown
keys, wrong types or invalid JSON stop the server with an error naming the field.

| OS | Default path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\multi-cdp-mcp\config.json` |
| macOS | `~/Library/Application Support/multi-cdp-mcp/config.json` |
| Linux | `$XDG_CONFIG_HOME/multi-cdp-mcp/config.json`, default `~/.config/multi-cdp-mcp/config.json` |

`MULTI_CDP_MCP_CONFIG` overrides the path. In OpenCode, set it in the server's
`environment` block.

## Browser

```json
{
  "browser": {
    "executable": "auto",
    "headless": true,
    "allowSync": false,
    "extraArgs": [],
    "portRange": { "start": 9400, "end": 9499 }
  }
}
```

- `executable`: `"auto"` or a path to the browser binary. `"auto"` tries, in order:

  | Browser | Windows | macOS | Linux (`PATH`) |
  | --- | --- | --- | --- |
  | Chromium | `%LOCALAPPDATA%\Chromium\Application\chrome.exe` | `Chromium.app` | `chromium`, `chromium-browser` |
  | Brave | `...\BraveSoftware\Brave-Browser\Application\brave.exe` | `Brave Browser.app` | `brave-browser`, `brave` |
  | Edge | `...\Microsoft\Edge\Application\msedge.exe` | `Microsoft Edge.app` | `microsoft-edge`, `microsoft-edge-stable` |
  | Chrome | `...\Google\Chrome\Application\chrome.exe` | `Google Chrome.app` | `google-chrome`, `google-chrome-stable` |

  On Windows it checks Program Files, Program Files (x86) and `%LOCALAPPDATA%`; on macOS
  `/Applications` and `~/Applications`. Google Chrome is last because Chrome 137+ ignores
  `--load-extension`: extension control and dev builds need another browser.
- `headless`: default for new environments. Agents override it with
  `cdp_environment_create({ headless: false })`; the choice is stored with the profile.
- `allowSync`: `false` (default) adds `--disable-sync`, and on Edge disables
  `msImplicitSignin`. Without it, Edge signs every fresh profile in to the Windows account
  and turns sync on, so the agent's profile would receive your passwords and history.
- `extraArgs`: extra switches for every launch, for example `["--lang=en-US"]`. Your own
  `--disable-features=...` values are merged with the server's, not replaced.
- `portRange`: inclusive range of local CDP ports. One port per running environment.

The old top-level `braveExecutable` key was removed. Use `browser.executable`.

## Profiles

```json
{
  "profileSource": {
    "mode": "fresh",
    "sourceUserDataDir": "auto",
    "refreshTemplate": false,
    "maxTemplateSizeGb": 5
  }
}
```

- `fresh` (default): every environment starts with an empty profile.
- `clone`: copy `sourceUserDataDir` once into `<dataRoot>/templates/default`, then seed
  each new environment from that template. `"auto"` uses the detected browser's own
  user-data directory (for example `~/.config/BraveSoftware/Brave-Browser`). Close that
  browser before the first copy or a refresh: a live profile is not a consistent snapshot.
- `template`: require an already prepared `<dataRoot>/templates/default`.

`refreshTemplate: true` rebuilds the template on the next server start. It affects only
future environments; existing profiles are never overwritten. `maxTemplateSizeGb` guards
against copying a huge profile by accident. Caches, crash dumps and lock files are skipped.

Cloned logins do not always survive: many sites bind sessions to the original profile,
and Chrome on Windows encrypts cookies per installation. Sign in once inside the
environment; the profile keeps it.

`cdp_environment_create({ fresh: true })` creates a one-off empty profile in any mode.

## Data directory

`dataRoot` holds `envs/<id>` (profiles), `templates/`, `logs/`, `artifacts/` and
`environments.json`.

| OS | Default `dataRoot` |
| --- | --- |
| Windows | `%LOCALAPPDATA%\multi-cdp-mcp` |
| macOS | `~/Library/Application Support/multi-cdp-mcp` |
| Linux | `$XDG_DATA_HOME/multi-cdp-mcp`, default `~/.local/share/multi-cdp-mcp` |

## Extensions

```json
{
  "extensions": {
    "controlExtensionPath": "<bundled>",
    "devExtensionPaths": ["/home/me/my-extension/dist"],
    "materializeProfileExtensions": true
  }
}
```

- `devExtensionPaths`: unpacked builds loaded into every environment. Each must be an
  absolute directory with a `manifest.json` and no comma in the path. Agents can add more
  per environment with `cdp_environment_create({ devExtensionPaths })`. A dev build whose
  manifest `name` matches a "Load unpacked" extension from the template replaces it.
- `materializeProfileExtensions`: keep `true` for cloned profiles. Chromium drops copied
  Web Store install records after the first launch; the server reloads those extensions as
  unpacked with their original keys, so their IDs and storage stay the same.
- `controlExtensionPath`: the bundled extension that provides enable/disable. Change it
  only for development.

Before each launch the server turns on developer mode in the profile, so the browser does
not disable command-line extensions on restart. If Edge still comes up with them disabled,
the server re-enables them from `edge://extensions`. Extensions disabled on purpose with
`cdp_extension_set_enabled` stay disabled.

## Paths readable by `install_extension`

`chrome-devtools-mcp` path tools only read inside their roots. Each environment gets:

1. `<dataRoot>/artifacts/<environment-id>`;
2. the OS temp directory;
3. `extensions.devExtensionPaths` and the environment's own `devExtensionPaths`;
4. `backend.filesystemRoots`.

Paths are compared after resolving symlinks and junctions; add the real target if a link
points elsewhere.

## Backend

```json
{
  "backend": {
    "runtime": "<the runtime running this server>",
    "enableExtensionTools": true,
    "filesystemRoots": [],
    "compactToolSchemas": true
  }
}
```

`runtime` defaults to the Bun binary that runs the server, so it works when the MCP client
starts with a minimal `PATH` (common for macOS GUI apps). `compactToolSchemas` shortens
downstream tool descriptions to their first sentence to save tokens.

## Limits

| Key | Default | Meaning |
| --- | --- | --- |
| `maxEnvironments` | `8` | Starting or running environments at once; stopped ones do not count |
| `startupTimeoutMs` | `60000` | Time for a browser to expose its CDP endpoint |
| `toolTimeoutMs` | `150000` | Every server-to-backend call; stays below Puppeteer's fixed 180 s protocol timeout |
| `navigationTimeoutMs` | `30000` | `navigate_page` / `new_page` timeout when the caller passes none |

`evaluate_script` also gets an in-page limit: its `timeout` argument, default
`toolTimeoutMs - 20 s`, at most 170 s.

## Caller identity

The server runs over stdio, so the request is the only place an identity can come from.
Precedence:

1. `_meta["ai.opencode/sessionID"]` (OpenCode 2.2.5+), then `_meta.sessionID`,
   `_meta.sessionId`, `_meta["opencode/sessionID"]`;
2. the `callerId` argument;
3. the transport session ID (session-aware transports only);
4. `explicit:<environmentId>` when only `environmentId` is passed, or `explicit:<name>`
   for `cdp_environment_create` with a `name`.

`cdp_environment_list` needs no identity. Calls with only an `environmentId` reach that
environment without changing its owner. `cdp_environment_stop` with an explicit
`environmentId` works for any idle environment; deleting someone else's environment needs
a takeover with `cdp_environment_select` first.

## Logging

Diagnostics go to stderr; stdout carries MCP frames. `MULTI_CDP_MCP_VERBOSE=1` adds debug
messages. Browser and backend logs are in `<dataRoot>/logs`.
