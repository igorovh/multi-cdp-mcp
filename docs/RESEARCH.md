# Research notes

Why the server works the way it does. Measured on Chromium 153–156 builds of Brave, Edge
and Chrome with `chrome-devtools-mcp` 1.9–1.12.

## Cloned profiles work

Copying a browser's user-data directory and launching the browser against the copy works.
Several clones run at once on separate ports and processes. Singleton locks
(`SingletonLock`, `SingletonCookie`, `SingletonSocket`) are symlinks and are not copied;
caches and crash dumps are skipped too.

## Cloned Web Store extensions vanish on the second launch

On the first launch of a clone, extensions run normally. During that session Chromium
rejects the copied preference MACs in `Default/Secure Preferences` and clears the install
records. On the next launch only command-line extensions remain.

The fix: `Secure Preferences` stores each extension's manifest including its `key` (the
public key the ID is derived from). Writing the key into the on-disk `manifest.json` and
loading the directory with `--load-extension` keeps the original ID, so
`chrome-extension://<id>/` storage survives. After the first launch Chromium drops the
stored manifest, so later launches find the extensions by scanning `Default/Extensions` for
manifests whose `key` reproduces the directory ID (`src/profile/extensions.ts`).

"Load unpacked" extensions from the source profile are cloned with an untrusted record:
Chromium keeps them disabled and refuses to enable them. Loading the same directory with
`--load-extension` makes them controllable.

Side effects: these extensions no longer auto-update, and they report
`installType: "development"`.

## Enable and disable need chrome.management

The CDP `Extensions` domain is unpacked-only and has no enable/disable command. A bundled
extension with the `management` permission fills the gap. `Runtime.evaluate` with
`userGesture: true` satisfies `chrome.management.setEnabled` without a dialog.

## The server launches the browser itself

Extension tools behave the same whether `chrome-devtools-mcp` launches the browser or
connects with `--browserUrl`. Launching it ourselves gives control over the profile
directory, port, flags and lifetime, and is the only way to pass `--load-extension`.

## Browser differences

- Google Chrome 137+ ignores `--load-extension` ("not allowed in Google Chrome"). Chromium,
  Brave and Edge accept it.
- Chromium 134+ disables command-line extensions on restart while developer mode is off;
  Edge does so after some restarts even when it was on. Hence the developer-mode
  preference and the `developerPrivate` repair.
- With a fixed `--remote-debugging-port`, Chrome and Edge do not write `DevToolsActivePort`.
  Reconnection therefore reads the profile path from `chrome://version` instead.

## Process notes

- Children spawned by Bun die with the parent, so the browser starts `detached`.
- On Windows `taskkill` without `/F` closes windows but not the browser process. A clean
  shutdown uses CDP `Browser.close`, which also flushes the profile.

## Logins

Sessions copied with a profile are often not valid: sites bind them to the original
profile, and Chrome on Windows uses app-bound cookie encryption. Signing in once inside a
persistent environment works, and stop/resume keeps it.
