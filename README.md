# multi-cdp-mcp

An MCP server that gives every AI agent conversation its own persistent, isolated
Chromium browser. Works with Chrome, Edge, Brave and Chromium on Windows, macOS and Linux.
It wraps the official [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
tools and adds environment management and extension control.

<p align="center">
  <img src="docs/demo.gif" alt="Three OpenCode sessions drive three isolated browsers at once: one signs in to a CRM, another is still signed out, a third fills a shopping cart" width="1000">
</p>

The demo shows three OpenCode sessions working in parallel, each in its own browser: one signs
in to a test CRM, the second checks the same CRM at the same time and is still signed out, and
the third fills a shopping cart.

```text
OpenCode conversation A ─┐                 ┌─ environment A ─ browser profile A (port 9400)
OpenCode conversation B ─┼─ multi-cdp-mcp ─┼─ environment B ─ browser profile B (port 9401)
OpenCode conversation C ─┘                 └─ environment C ─ browser profile C (port 9402)
```

## Features

- **One browser per conversation.** The first browser call creates an environment for
  that conversation. Tabs, cookies, logins and extensions never leak between conversations.
- **Persistent profiles.** Stop an environment and resume it later with its logins and
  extension state intact. Name environments to come back to them.
- **Any Chromium browser.** Detects Chromium, Brave, Edge or Chrome automatically, or uses
  the binary you configure.
- **Extension control.** List, enable, disable and reload any extension. Load unpacked
  builds per environment (`devExtensionPaths`), handy for testing worktree builds side by side.
- **Headless or visible.** Headless by default; pass `headless: false` when a human has to
  log in or watch.
- **Agent-friendly page tools.** `evaluate_script` gets an in-page `timeout`; `click` and
  `hover` accept a CSS `selector` or `x`/`y`; `bringToFront` avoids throttled background tabs.
- **Survives crashes.** Browsers outlive the server. A restarted server reconnects to them
  after checking each browser's profile path.
- **Agent skill included.** Teaches the agent when to use visible windows, how to test
  extensions and how to clean up safely.

## Requirements

- [Bun](https://bun.sh) 1.2 or newer.
- A Chromium-based browser: Chromium, Brave, Microsoft Edge or Google Chrome.
  Google Chrome 137+ ignores command-line extensions, so extension control and
  `devExtensionPaths` need Chromium, Brave or Edge. Everything else works in Chrome.
- For OpenCode: version 2.2.5 or newer. Older versions do not send the conversation ID
  from Code Mode, so agents must pass `callerId` themselves.

## Install

Add the server to your OpenCode config (`~/.config/opencode/opencode.jsonc`, or
`opencode.jsonc` in a project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "multi-cdp": {
        "type": "local",
        "command": ["bunx", "github:igorovh/multi-cdp-mcp#v0.2.1"],
        "codemode": true,
        "timeout": { "startup": 60000, "catalog": 30000, "execution": 600000 }
      }
    }
  }
}
```

`#v0.2.1` pins a release. Change it to a newer tag to upgrade; without a tag, `bunx` may keep
using whatever version it cached first.

Restart OpenCode and check that it connects:

```sh
opencode mcp list
```

Then install the agent skill, so agents know how to use the tools well:

```sh
bunx github:igorovh/multi-cdp-mcp#v0.2.1 install-skill
```

It copies [`multi-cdp-browser`](./.opencode/skills/multi-cdp-browser/SKILL.md) to
`~/.config/opencode/skills/`.

Other MCP clients work the same way: run `bunx github:igorovh/multi-cdp-mcp#v0.2.1` as a stdio server.

<details>
<summary>Install from a local clone instead</summary>

```sh
git clone https://github.com/igorovh/multi-cdp-mcp
cd multi-cdp-mcp
bun install
```

```jsonc
"command": ["bun", "run", "/path/to/multi-cdp-mcp/src/index.ts"]
```

</details>

## Configuration

Everything works without a config file. To change defaults, create `config.json`:

| OS | Default config path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\multi-cdp-mcp\config.json` |
| macOS | `~/Library/Application Support/multi-cdp-mcp/config.json` |
| Linux | `$XDG_CONFIG_HOME/multi-cdp-mcp/config.json` (`~/.config/...`) |

Set `MULTI_CDP_MCP_CONFIG` to use another file. Partial files are fine; unknown keys and
wrong types stop the server with a clear error. A full example is in
[`config.example.json`](./config.example.json).

| Option | Default | Meaning |
| --- | --- | --- |
| `browser.executable` | `"auto"` | Path to the browser binary, or `"auto"` (tries Chromium, Brave, Edge, Chrome) |
| `browser.headless` | `true` | Default for new environments; agents can override per environment |
| `browser.allowSync` | `false` | Allow browser sync. Off by default, which also stops Edge from signing new profiles in to your Windows account |
| `browser.extraArgs` | `[]` | Extra command-line switches for every browser |
| `browser.portRange` | `9400`–`9499` | Local CDP ports, one per running environment |
| `profileSource.mode` | `"fresh"` | `fresh`: empty profiles. `clone`: copy your browser profile once into a template. `template`: reuse a prepared template |
| `profileSource.sourceUserDataDir` | `"auto"` | Profile to clone; `"auto"` uses the detected browser's own profile |
| `extensions.devExtensionPaths` | `[]` | Unpacked extensions loaded into every environment |
| `backend.filesystemRoots` | `[]` | Extra directories `install_extension` and other path tools may read |
| `dataRoot` | per-OS data dir | Where profiles, templates and logs live |
| `limits.maxEnvironments` | `8` | Running environments at once |

More options and details: [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md).

> **`clone` copies your real browser profile**, including cookies and saved sessions,
> into `dataRoot`. Close the browser before the first copy. Some sites (and Chrome's
> app-bound cookie encryption on Windows) still require a fresh login; sign in once inside
> the environment and it stays signed in.

## Tools

All `chrome-devtools-mcp` tools keep their names and results. The server adds:

| Tool | Purpose |
| --- | --- |
| `cdp_environment_create` | Create and bind an environment (`name`, `headless`, `fresh`, `devExtensionPaths`) |
| `cdp_environment_list` | List environments with state, owner and extension-control status |
| `cdp_environment_select` | Resume an environment, or take over an idle one |
| `cdp_environment_stop` | Close the browser, keep the profile |
| `cdp_environment_release` | Unbind without stopping |
| `cdp_environment_delete` | Delete one environment and its profile |
| `cdp_environment_delete_all` | Delete everything (requires an exact confirmation string) |
| `cdp_extension_list` | Extensions with enabled state, source and `controllable` |
| `cdp_extension_set_enabled` | Enable or disable an extension |
| `cdp_extension_reload` | Reload an extension |

## How it works

For each environment the server launches the browser itself, with its own
`--user-data-dir`, a free CDP port and the bundled control extension, then starts a
dedicated `chrome-devtools-mcp` process connected to that port. Calls are routed by the
conversation ID that OpenCode sends in `_meta["ai.opencode/sessionID"]`; clients that send
none can pass `callerId` or `environmentId`.

The CDP `Extensions` domain cannot enable or disable extensions, so a tiny bundled extension
with the `management` permission does it; the server drives it over CDP. Cloned Web Store
extensions are re-declared as unpacked with their original keys, so their IDs and storage
survive restarts.

Details: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`docs/RESEARCH.md`](./docs/RESEARCH.md).

## Security model

This is a local developer tool. Keep in mind:

- Any local process can connect to an environment's CDP port on `127.0.0.1` and control
  that browser, including its logged-in sessions.
- Any MCP caller can pass any `callerId` or `environmentId`; the server separates
  conversations, it does not authenticate them.
- In `clone` mode, `dataRoot` holds copies of your cookies and sessions. On macOS and
  Linux the server creates profile directories with mode `0700`.
- Agents can add directories to `devExtensionPaths`; those become readable by
  `install_extension` for that environment.
- Browser sync is disabled unless `browser.allowSync` is `true`. Without this, Edge signs a
  fresh profile in to the Windows account and syncs passwords and history both ways.

## Development

```sh
bun install
bun run test          # unit tests
bun run typecheck     # strict TypeScript
bun run smoke         # two conversations end to end (launches real browsers)
bun run smoke:crash   # kill the server, reconnect to the surviving browser
bun run acceptance    # three concurrent conversations
```

The end-to-end scripts use `"auto"` browser detection and fresh profiles. Set
`MULTI_CDP_BROWSER=<path>` to pick a browser, or `MULTI_CDP_CLONE_FROM=<user data dir>` to
test cloning. `MULTI_CDP_MCP_VERBOSE=1` enables debug logs on stderr.

Troubleshooting: [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md).

## License

[MIT](./LICENSE)
