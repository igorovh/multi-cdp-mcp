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

## 2. A cloned profile loses its Web Store extensions on the first restart

This is the trap in this project, and it is silent.

On the **first** launch of a clone the extensions run normally. During that session
Chromium rejects the copied tracked-preference MACs in `Default/Secure Preferences` and
clears the extension install records. On the **second** launch there are no records left,
so `chrome.management.getAll()` returns only the extensions passed on the command line.

Symptoms that made this hard to spot: the first run looks perfect, and the extension
directories under `Default/Extensions` are still on disk the whole time.

### Fix: re-declare each extension as unpacked, keeping its ID

`Default/Secure Preferences` stores each extension's full manifest, including its `key`
— the base64 public key. An extension's ID is derived from that key, so writing it back
into the on-disk `manifest.json` and loading the directory with `--load-extension`
reproduces the original ID.

Keeping the ID matters: `chrome-extension://<id>/` is the origin for the extension's
`chrome.storage.local`, IndexedDB and localStorage, so its settings and logins survive.

`prepareUnpackedExtensions()` in `src/profile/extensions.ts` does this.

Correction (2026-10-03): after the first launch Chromium rewrites each record as a
command-line extension without the stored manifest, so re-reading `Secure Preferences` on
the next start found nothing and every template extension vanished, enabled or not. The
function now also scans `Default/Extensions` for manifests whose written `key` reproduces
the directory ID. Disabled state is kept in the preferences and survives the restart.

"Load unpacked" extensions in the source profile (absolute `path`, location 4) are cloned
with an untrusted record: Chromium loads them disabled with `disabledReason: "unknown"`
and rejects `setEnabled` with "cannot be modified by user". Loading the same directory
with `--load-extension` keeps the path-derived ID and makes it controllable.

Side effects, both acceptable:

- The extensions no longer auto-update, which makes environments reproducible.
- They now report `installType: "development"` rather than `"normal"`.

## 3. Extension management needs chrome.management, not the CDP Extensions domain

An earlier revision of this document blamed Brave for under-reporting extensions. That
was wrong. The CDP `Extensions` domain registers itself as:

```
Extensions.getExtensions  →  "Gets a list of all unpacked extensions."
Extensions.uninstall      →  "Uninstalls an unpacked extension (others not supported)"
```

It is unpacked-only by design, on Chrome as much as on Brave, and it has **no
enable/disable command at all**. `list_extensions` was reporting correctly; there simply
was nothing else for it to see.

Two consequences:

- After the fix in finding 2 every extension is unpacked, so `list_extensions`,
  `reload_extension`, `install_extension`, `uninstall_extension` and
  `trigger_extension_action` all became usable. The harness now sees 9 of 9.
- Enable and disable still do not exist in CDP. They are driven through
  `chrome.management` inside a bundled control extension
  (`scripts/feasibility/fixtures/control-extension`), attached over CDP and evaluated in
  its service worker.

`chrome.management.setEnabled` is documented as usually requiring a user gesture.
`Runtime.evaluate` with `userGesture: true` satisfies it: no confirmation dialog appeared,
and toggling the dev fixture off and on removed and restored its content-script marker in
both environments. Disabling a Web Store extension also stopped its service worker.

Attaching a debugger session to the control extension's service worker keeps it from going
dormant, which is why the proxy should attach once at environment start and hold it.

## 4. Transport decision: proxy launches Brave, backend connects via `--browserUrl`

Extension tooling behaves the same over `--browserUrl` and with the backend launching
Brave itself (`probe-extension-tools.ts`), so the tie is broken by lifecycle control.
Launching Brave ourselves gives explicit control over the profile directory, port, launch
arguments and browser lifetime, and avoids Puppeteer's default switches. It is also the
only way to pass `--load-extension`, which finding 2 depends on.

This resolves the open question in section 6 of `PLAN.md` in favour of the first option.

`--categoryExtensions` is accepted over `--browserUrl` on Chromium 153; the restriction in
the upstream configuration docs applied to versions before 149.

## 5. Isolation and lifecycle hold

- Navigating one environment does not affect the other.
- Stopping one browser leaves the other serving on its own port.
- A stopped environment restarts from the same directory with its extensions intact.

## 6. Windows process notes

Two things that will matter for the proxy as well:

- Children spawned by Bun die with the parent. Brave must be started with
  `detached: true` plus `unref()` to outlive the process that launched it.
- `taskkill` closes windows but leaves the browser process running. A graceful shutdown
  needs CDP `Browser.close`, which also flushes the profile to disk.

## 7. Authentication: cloned sessions did not survive

Cookie **names** are recorded per site, never values. After cloning:

| Site | Session cookies present | Reading |
| --- | --- | --- |
| kick.com | `kick_session`, but the page shows **Sign in** | Not authenticated; the cookie is also used for anonymous sessions |
| twitch.tv | `api_token`, `server_session_id`, but **no `auth-token`** and the page exposes the login control | Not authenticated |

Neither required website retained its authenticated session after cloning. This is
consistent with modern Chromium app-bound cookie protection: copying the profile files is
not sufficient even under the same Windows account.

The supported workflow is a one-time sign-in inside each persistent environment. Finding 2
guarantees the extension origins are stable, and the profile is preserved across
stop/resume, so those new logins persist with that environment.

## Still unverified

- Whether the Twitch/Kick extensions behave correctly on their target sites beyond
  starting their service workers.
