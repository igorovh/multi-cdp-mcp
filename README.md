# multi-cdp-mcp

Local MCP proxy that gives every OpenCode conversation its own persistent, isolated
Brave browser environment.

```text
OpenCode session A ─┬─ multi-cdp-mcp ─ environment A ─ Brave profile A
OpenCode session B ─┤                 ─ environment B ─ Brave profile B
OpenCode session C ─┘                 ─ environment C ─ Brave profile C
```

The proxy keeps the official `chrome-devtools-mcp` tools and routes calls using
`CallToolRequest.params._meta.sessionID`. No model-visible environment ID is needed for
normal OpenCode calls.

## Status

Phases 1–4 from [`PLAN.md`](./PLAN.md) are implemented and validated on Windows with:

- Brave `153.1.95.102` / Chromium `153.0.8010.48`
- Bun `1.4.0`
- `chrome-devtools-mcp` `1.9.0`
- `@modelcontextprotocol/sdk` `1.22.0`

The three-conversation acceptance suite passes, including concurrent lazy startup,
separate ports/profiles/backends, extension control, screenshot forwarding, handover,
stop/resume and hard-crash recovery.

Cloned Twitch and Kick sessions did not remain authenticated. Sign in once inside each
persistent environment; subsequent stop/resume keeps that environment's profile.

## Quick start

```powershell
bun install
bun run typecheck
bun run start
```

This repository already contains [`opencode.jsonc`](./opencode.jsonc), so OpenCode V2
discovers the server when started in this project. Check it with:

```powershell
opencode mcp list
```

OpenCode exposes the server under `tools.multi-cdp`. Browser calls lazily create an
environment for the invoking conversation.

## Profiles

The default configuration clones a prepared Brave template under
`%LOCALAPPDATA%\multi-cdp-mcp\templates\default` and creates persistent profiles under
`%LOCALAPPDATA%\multi-cdp-mcp\envs\<environment-id>`.

Set `profileSource.mode` in `%LOCALAPPDATA%\multi-cdp-mcp\config.json`:

| Mode | Behaviour |
| --- | --- |
| `clone` | Build/reuse a template copied from `sourceUserDataDir`; carries logins and extensions |
| `fresh` | New environments start from an empty Brave profile |
| `template` | Require and reuse an already prepared `templates\default` directory |

`cdp_environment_create` also accepts `fresh: true` for a one-off empty profile, and
`devExtensionPaths` for worktree-specific unpacked builds.

Copy [`config.example.json`](./config.example.json) to
`%LOCALAPPDATA%\multi-cdp-mcp\config.json` to override defaults. Set
`MULTI_CDP_MCP_CONFIG` to use another file.

> Close the source Brave profile before the first template copy or an explicit refresh.
> A live Chromium profile is not a consistent snapshot.

## Management tools

| Tool | Purpose |
| --- | --- |
| `cdp_environment_create` | Create and bind a named, template-based or fresh environment |
| `cdp_environment_list` | Show persistent environments and lifecycle/ownership state |
| `cdp_environment_select` | Select/resume an existing environment; explicit handover when idle |
| `cdp_environment_stop` | Stop processes while retaining the profile |
| `cdp_environment_release` | Release a binding without stopping the browser |
| `cdp_extension_list` | List every extension, including enabled state |
| `cdp_extension_set_enabled` | Enable or disable any extension by ID |
| `cdp_extension_reload` | Reload any extension by disabling and re-enabling it |

All 34 downstream DevTools tools retain their original names and result structures.

## Development

```powershell
bun run test          # unit tests
bun run typecheck     # strict TypeScript
bun run build         # bundle for the Bun runtime
bun run smoke         # two-session end-to-end test
bun run smoke:crash   # hard-crash/reconnection test
bun run acceptance    # three concurrent conversations
bun run feasibility --close
```

See:

- [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md)
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)
- [`docs/findings.md`](./docs/findings.md) for the profile/extension research
