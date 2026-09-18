# multi-cdp-mcp

An MCP proxy that gives each agent conversation its own isolated Brave browser
environment, so several conversations can drive separate browsers at the same time.
See [`PLAN.md`](./PLAN.md) for the full design.

Status: **Phase 1 (feasibility) complete.** The proxy itself is not implemented yet.

## Requirements

- Windows with Brave installed
- [Bun](https://bun.sh) 1.4+

## Feasibility harness

Proves that cloned Brave profiles can run independent, extension-enabled,
DevTools-MCP-controlled environments concurrently.

```bash
bun install
bun run feasibility          # leaves both browsers open for manual inspection
bun run feasibility --close  # shuts them down at the end
```

Results are written to `docs/feasibility-report.md`. Screenshots and browser logs go to
`docs/feasibility/` and `%LOCALAPPDATA%\multi-cdp-mcp\logs\`.

Before a real run, edit [`scripts/feasibility/config.ts`](./scripts/feasibility/config.ts):

| Setting | Purpose |
| --- | --- |
| `profileSource.mode` | `clone` copies your Brave profile, `fresh` starts empty, `template` reuses a prepared one |
| `testUrls` | Sites checked for retained authentication |
| `devExtensionPath` | Unpacked extension build to load; defaults to a bundled fixture |
| `environments` | Environment IDs and their remote debugging ports |

With `mode: "clone"` all Brave windows must be closed first — a live profile is not a
consistent snapshot, and the harness refuses to copy one.

## Findings

See [`docs/findings.md`](./docs/findings.md) for what the harness established about
Brave, profile cloning, and the DevTools MCP connection modes.
