# Architecture

## Request path

```text
MCP tools/call
  └─ caller identity (_meta session ID, callerId or environmentId)
      └─ EnvironmentManager binding
          ├─ persistent profile + atomic process lock
          ├─ detached browser process + dedicated CDP port
          ├─ CDP client + extension-control service worker
          └─ dedicated chrome-devtools-mcp stdio client
```

`evaluate_script`, `click`, `hover`, `navigate_page` and `new_page` pass through a thin
layer (`src/server/page-tools.ts`): in-page timeouts, `bringToFront`, selector and
coordinate input through CDP `Input.dispatchMouseEvent`, and page state after a navigation
timeout. Every other tool is forwarded unchanged.

The server discovers downstream tool schemas with a throwaway backend pointed at an
unreachable endpoint. `chrome-devtools-mcp` connects lazily, so discovery launches no browser.

The browser binary is resolved on the first launch (`src/browser/detect.ts`), so the server
starts and lists tools even when no browser is installed.

## Concurrency

- Creation and startup are single-flight per conversation and environment.
- Ports are reserved before the browser starts, including during concurrent starts.
- Every environment has its own backend; there is no global browser lock.
- `activeCalls` prevents stop or handover while a tool call is running.
- Cancellation and timeouts reach only the affected backend call.
- Mutating calls are never replayed after a backend failure.

## Persistence and crash recovery

`environments.json` stores profile identity, not trusted live state. MCP clients often run
one server process per project, all sharing `dataRoot`, so each write takes a lock file
(`environments.json.lock`, with dead-owner detection), re-reads the file, applies only its
own change and replaces the file atomically. Profile lock files use exclusive creation and contain the server's PID.

Browsers are launched detached, so they survive a server crash. A new server reconnects
only when the browser on the recorded port reports the environment's profile directory on
`chrome://version`; it reads the browser PID from CDP `SystemInfo.getProcessInfo`. A saved
PID is never trusted on its own, and a browser whose PID cannot be confirmed is never
force-killed.

Stopping or deleting an environment whose browser is gone does not launch a new one.

## Extension control

The CDP `Extensions` domain handles unpacked extensions only and cannot enable or disable
them. The bundled control extension holds the `management` permission. The server attaches
to its MV3 service worker and calls `chrome.management` through
`Runtime.evaluate(userGesture: true)`. The attachment keeps the worker alive; if the worker
is dormant, the server opens `chrome-extension://<id>/control.html` once to wake it.

Command-line extensions need developer mode, or Chromium disables them on restart. The
server sets `extensions.ui.developer_mode` in the profile before each launch. When an
expected extension still comes up disabled (seen on Edge), it enables developer mode
through `chrome.developerPrivate` on the browser's extensions page and re-enables the
extensions it loaded, except those the caller disabled on purpose.

## Deletion safety

Profile deletion is limited to the `envs` directory under `dataRoot`. Running environments
are rejected unless `force: true`; active calls and startups are never forced. Bulk
deletion also requires the exact string `DELETE ALL ENVIRONMENTS`.
