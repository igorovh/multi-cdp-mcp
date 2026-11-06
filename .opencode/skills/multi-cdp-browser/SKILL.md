---
name: multi-cdp-browser
description: Control isolated, persistent browser environments through the multi-cdp MCP server. Use this skill whenever the user asks to browse or interact with websites, log in somewhere, inspect console/network/performance, take screenshots, test or reload browser extensions, manage browser environments, or run several browser tasks at once, even when they do not mention multi-cdp. Prefer this workflow over Playwright or a standalone Chrome DevTools server whenever multi-cdp tools are available.
compatibility: OpenCode 2.2.5 or newer with the multi-cdp MCP server configured
---

# Multi-CDP browser workflow

Every conversation gets its own browser environment: a separate profile, port and set of
tabs. The first browser call creates it; later calls reuse it. Nothing is shared between
conversations unless you hand an environment over on purpose.

## Cheat sheet

Call as `tools["multi-cdp"].<name>(args)` inside `execute`. Do not search the catalog for these.

| Tool | Args |
| --- | --- |
| `cdp_environment_create` | `{ name?, headless?, fresh?, devExtensionPaths? }` |
| `cdp_environment_list` | `{}` (shows state, owner, `extensionControl`) |
| `cdp_environment_select` | `{ environmentId }` |
| `cdp_environment_stop` | `{ environmentId? }` |
| `cdp_environment_release` | `{}` |
| `cdp_extension_list` | `{}` (check `controllable` before toggling) |
| `cdp_extension_set_enabled` | `{ extensionId, enabled }` |
| `cdp_extension_reload` | `{ extensionId }` |
| `list_pages` / `select_page` | `{}` / `{ pageId, bringToFront? }` |
| `new_page` / `navigate_page` | `{ url }` / `{ pageId, type: "url", url, timeout? }` |
| `take_snapshot` / `take_screenshot` | `{ pageId }` |
| `click` / `hover` | `{ pageId, uid \| selector \| x+y, bringToFront?, dblClick? }` |
| `fill_form` / `type_text` / `press_key` | `{ pageId, elements }` / `{ pageId, text }` / `{ pageId, key }` |
| `evaluate_script` | `{ pageId, function, timeout?, bringToFront? }` |
| `list_console_messages` / `list_network_requests` | `{ pageId }` |

## Before the first browser call

Decide what the task needs, then either let the first call create a default environment
or call `cdp_environment_create` yourself:

| Task | Do this |
| --- | --- |
| Reading pages, screenshots, DOM, console, network, performance | Just call `list_pages`; the default headless environment is created for you |
| Login, CAPTCHA, extension popups, toolbar actions, anything the user must see or do | `cdp_environment_create({ headless: false })` |
| Work the user will come back to later | Add a stable `name`, for example `{ name: "shop-checkout" }` |
| A clean browser with no cookies or extensions from the template | Add `fresh: true` |
| Testing an extension build from this project or worktree | Add `devExtensionPaths: ["<absolute path to the unpacked build>"]` |

When the user has to sign in, open a visible environment, navigate to the login page and
ask them to sign in. The profile keeps that login across stop and resume.

## Working with pages

1. Get a `pageId` from `list_pages` (or `new_page`) before page-scoped calls.
2. Prefer `take_snapshot` and element `uid`s for clicking and filling forms.
3. Controls that hide on mouse-out (video players, menus) invalidate snapshot `uid`s. Use
   `hover({ pageId, selector })`, then `click({ pageId, selector })`; the pointer stays
   where `hover` left it.
4. Background tabs throttle timers and `requestAnimationFrame`. Pass `bringToFront: true`
   to `evaluate_script`, `click` or `hover` for anything timing-sensitive.
5. Keep in-page waits under about 15 s. For longer scripts pass `timeout` (ms, max 170000)
   to `evaluate_script`.
6. A navigation timeout usually means the load event was slow, not that the page failed.
   The result includes the URL and `readyState`; check them before retrying, and pass a
   larger `timeout` for heavy sites.

## Extension development

1. Build the extension first; the browser loads the unpacked directory, not your sources.
2. `cdp_extension_list` gives IDs, enabled state and `controllable`.
3. After rebuilding, call `cdp_extension_reload`.
4. Use `cdp_extension_set_enabled` for on/off tests. A disabled extension stays disabled
   across restarts until you enable it again.
5. `install_extension` only reads the OS temp directory, `devExtensionPaths` and the
   configured `backend.filesystemRoots`. Prefer `devExtensionPaths` for worktree builds.
6. Verify behaviour through page effects, console output or network activity, not only by
   checking that the extension is listed.
7. If `extensionControl` is `unavailable`, read `extensionControlError`. Google Chrome
   ignores command-line extensions; extension control needs Chromium, Brave or Edge.
   Otherwise `cdp_environment_stop` and retry.

## Reuse and handover

- Use the environment bound to this conversation unless the user asks for another one.
- Check `cdp_environment_list` before creating more named environments.
- `cdp_environment_select({ environmentId })` resumes a stopped environment or takes over
  an idle one from another conversation. Do this only when the user wants that.
- Never assume two conversations share tabs, cookies, selected pages or extension state.

## Identity

OpenCode sends the conversation's session ID with every call, including calls from
`execute`. If a call still fails with "No caller identity", pass
`callerId: "<current session ID>"` on every call, always the same value, or pass
`environmentId` to address an environment directly.

## Lifecycle

- `cdp_environment_stop` closes the browser and keeps the profile. The next browser call
  resumes it.
- `cdp_environment_release` unbinds this conversation without stopping the browser.
- Stop environments you no longer need; they hold memory and a port.

## Destructive operations

Delete only when the user explicitly asks.

- `cdp_environment_delete({ environmentId })` permanently removes one profile. Pass
  `force: true` only if the user wants a running environment stopped and deleted.
- `cdp_environment_delete_all` removes every environment. Call it only after an explicit
  delete-all request, with `confirm: "DELETE ALL ENVIRONMENTS"`.

## Reporting

Say which environment you created, selected, stopped or deleted when it matters. Never
expose cookie values, tokens, private page content, profile files or session IDs.
