# OpenCode: Code Mode calls lose `_meta.sessionID`

## Observed

Direct MCP tool calls from an OpenCode session reach this server with
`params._meta.sessionID`. Calls made from inside Code Mode `execute`
(`tools["multi-cdp"].<tool>(args)`) arrive with no `_meta` at all:

```text
No caller identity: the request carried no _meta.sessionID (received _meta keys: none).
```

The server uses stdio, so there are no HTTP headers or transport session IDs to fall back
on. The request body is the only place an identity can come from.

## Minimal upstream change

When the Code Mode runtime turns `tools["<server>"].<tool>(args)` into an MCP
`tools/call`, it should attach the invoking session the same way direct tool calls do:

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "<tool>",
    "arguments": { /* args */ },
    "_meta": { "sessionID": "<session that called execute>" }
  }
}
```

That is, pass the `execute` tool's own session ID into the client `callTool` request
`_meta` for every nested call.

## Server-side mitigation in this repository

- `callerId` is accepted on every tool and ranks directly after `_meta`.
- An `environmentId` alone addresses that environment without touching its binding, and
  `cdp_environment_create({ name })` without identity uses the same `explicit:<name>`
  identity, so an `environmentId`-only workflow stays consistent.
- `cdp_environment_list` works without identity.
- The missing-identity error lists the `_meta` keys that did arrive.
