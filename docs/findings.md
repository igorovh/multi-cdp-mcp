# Phase 1 Findings

Measured on 2026-09-18 with Brave `153.1.95.102` (Chrome/153.0.8010.48),
`chrome-devtools-mcp` `1.9.0`, Bun `1.4.0`, on Windows.
Reproduce with `bun run feasibility`; raw results land in `docs/feasibility-report.md`.

## 1. Cloned profiles work

Copying `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data` into a new directory and
launching Brave against it works. Two clones ran concurrently on separate remote
debugging ports with separate browser processes.

The source profile was 0.15 GB after pruning caches, crash dumps and singleton locks —
small enough that cloning per environment is cheap.

Singleton locks (`SingletonLock`, `SingletonCookie`, `SingletonSocket`) are symlinks and
must not be carried over; the harness skips all non-regular files.

## 2. Extensions run in clones

All six standard extensions started their service workers in both clones. This is the
result that matters, and it is measured over CDP `Target.getTargets` rather than through
the MCP extension tools — see finding 3.

An unpacked extension passed via `--load-extension` also loaded, and its content script
executed on a real page in both environments. That covers the extension-under-development
requirement without needing `install_extension`.

MV3 service workers are event-driven. After a stop/resume cycle the worker count drops to
near zero until something wakes them, which is normal and not a regression. Navigating to a
page the extension matches is the meaningful check.

## 3. Brave does not back the DevTools MCP extension tools

`list_extensions` reports 1–2 extensions while 7 are demonstrably running. Measured both
over a `--browserUrl` connection and with the backend launching Brave itself
(`scripts/feasibility/probe-extension-tools.ts`); **both report the same wrong number**.

So this is a Brave limitation, not a transport limitation. Consequences:

- Do not rely on `list_extensions`, `install_extension`, `reload_extension`,
  `trigger_extension_action` or `uninstall_extension` on Brave.
- Load the development extension with `--load-extension` at browser launch instead.
- Verify extension behaviour through page effects, not through the extension tools.

## 4. Transport decision: proxy launches Brave, backend connects via `--browserUrl`

Since extension tooling is equally broken in both modes, the tie is broken by lifecycle
control. Launching Brave ourselves gives explicit control over the profile directory,
port, launch arguments, and browser lifetime, and avoids Puppeteer's default switches.

This resolves the open question in section 6 of `PLAN.md` in favour of the first option.

Note that `--categoryExtensions` *is* accepted over `--browserUrl` on Chromium 153; the
restriction described in the upstream configuration docs applied to versions before 149.

## 5. Isolation and lifecycle hold

- Navigating one environment does not affect the other.
- Stopping one browser leaves the other serving on its own port.
- A stopped environment restarts from the same directory with its state intact.

## 6. Windows process notes

Two things that will matter for the proxy as well:

- Children spawned by Bun die with the parent. Brave must be started with
  `detached: true` plus `unref()` to outlive the process that launched it.
- `taskkill` closes windows but leaves the browser process running. A graceful shutdown
  needs CDP `Browser.close`, which also flushes the profile to disk.

## Still unverified

- **Authentication.** `testUrls` is empty, so only a placeholder page was loaded. Cookie
  encryption keys are DPAPI-wrapped for the current Windows user, so cloning within the
  same account should preserve them, but this needs a per-site check by a human.
- Whether extensions behave correctly beyond starting, e.g. on their target sites.
- Three concurrent environments; only two were tested.
