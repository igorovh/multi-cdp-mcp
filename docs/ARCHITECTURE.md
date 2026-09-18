# Architecture

## Request path

```text
OpenCode tools/call
  └─ _meta.sessionID
      └─ EnvironmentManager binding
          ├─ persistent profile + atomic process lock
          ├─ detached Brave process + dedicated CDP port
          ├─ CDP client + extension-control service worker
          └─ dedicated chrome-devtools-mcp stdio client
```

The proxy discovers downstream tool schemas with a throwaway backend connected to an
unreachable endpoint. `chrome-devtools-mcp` connects to a browser lazily, so discovery
does not allocate a profile or launch Brave.

## Concurrency

- Creation and startup are single-flight per session/environment.
- Ports are reserved before browser startup, including concurrent starts.
- Every environment has its own backend connection; there is no global browser lock.
- `activeCalls` prevents stop or handover while a tool is in flight.
- Tool cancellation and timeout are passed to the affected downstream call only.
- Mutating calls are never replayed after a backend failure.

## Persistence and crash recovery

`environments.json` is replaced atomically and stores profile identity, not trusted live
state. Profile lock files use exclusive creation and include the proxy PID.

After a hard proxy crash, Brave survives by design. A new proxy reconnects only after it
finds a live Windows process whose executable, `--user-data-dir` and
`--remote-debugging-port` all match the environment record, then verifies the CDP endpoint.
A saved PID alone is never trusted.

## Extension control

The CDP `Extensions` domain is unpacked-only and has no enable/disable method. The bundled
control extension holds `management` permission. The proxy attaches to its MV3 service
worker and calls `chrome.management` through `Runtime.evaluate(userGesture: true)`.

The debugger attachment keeps the service worker alive while the environment runs.

## Deletion safety

Profile deletion is constrained to the configured `envs` root. Running environments are
rejected unless `force: true`; active calls and startups are never forced. Bulk deletion
also requires the exact confirmation string `DELETE ALL ENVIRONMENTS`.
