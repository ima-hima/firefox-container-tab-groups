# Container Corral

A Firefox extension that corrals your Multi-Account Container tabs into
Firefox's native tab groups (Firefox 140+):

1. **Group tabs by container.** One native tab group per container. Open a tab
   in your "Work" container and it joins the "Work" tab group; open one in
   "Shopping" and it goes to "Shopping". The group's name and color follow the
   container. 
1. Because a tab group can't span windows, a tab is moved to the
   window that already holds its container's group. This prevents there being multiple groups with the same name in different windows, and keeps all tabs in a container together. 
2. **Open sites in a container.** A list of `site → container` rules. When you
   open a matching site, the tab is reopened in the chosen container (and so
   lands in that container's group). Rules can be added from the options page or
   straight from the tab's right-click menu.
3. **Inherit the container for new tabs** (optional). A blank new tab opens in the
   same container as the current tab.

## Install

This extension isn't published on [addons.mozilla.org](https://addons.mozilla.org),
so pick one of these.

### Try it now (temporary)

1. Clone the repo:
   ```bash
   git clone https://github.com/ima-hima/container-corral
   ```
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose `manifest.json` from the clone.

It works immediately but is removed when Firefox restarts. Good for a test drive.

### Permanent (self-signed through AMO)

Release Firefox only runs signed extensions, but Mozilla signs *unlisted* builds
automatically with no review:

1. Sign in with a Firefox account and generate API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/>.
2. Build and sign:
   ```bash
   npm install
   WEB_EXT_API_KEY=<issuer> WEB_EXT_API_SECRET=<secret> npm run sign
   ```
   This drops a signed `.xpi` in `web-ext-artifacts/`.
3. Install it: open `about:addons`, click the gear ⚙ → **Install Add-on From
   File…**, and pick the `.xpi` (or just drag the `.xpi` onto a Firefox window).

To update later: bump `version` in `manifest.json`, re-run `npm run sign`,
reinstall the new `.xpi`.

### Firefox Developer Edition / Nightly / ESR

Set `xpinstall.signatures.required` to `false` in `about:config`, then install
the unsigned `web-ext-artifacts/*.zip` from `npm run build` the same way as
above. This toggle has no effect on release or Beta Firefox.

## How it works

**Grouping**

- `contextualIdentities.query()` + `tab.cookieStoreId` identify a tab's container.
- One group per container is tracked in a `cookieStoreId → {groupId, windowId}`
  map persisted in `storage.local` (so it survives the background page being
  suspended and browser restarts; entries are validated on use and dropped when
  stale). This is the primary lookup.
- The fallback is matching a group by (trimmed, case-insensitive) title across
  **all** windows. The oldest group id wins as the canonical one; same-window
  duplicates are merged into it immediately, cross-window duplicates are drained
  by the next reconcile.
- On tab create / attach, the tab is moved to the canonical group's window (via
  `tabs.move()`) and added to the group (`tabs.group()`), creating the group if
  none exists. A tab already sitting in a correctly-named group is left in place.
- If the moved tab was the active one in its old window, focus follows it: the
  destination window is raised (`windows.update({focused:true})`) and the tab is
  selected there. Bulk reconciles never steal focus.
- A tab added to a group is slid to the **rightmost** end of that group by
  default; the options page can switch this to leftmost. Existing tabs already
  in the group aren't reordered.
- Group title/colour are synced from the container (`tabGroups.update()`) and
  re-synced when a container is renamed or recoloured.
- On startup / install / container add·remove / settings change, everything is
  reconciled: tabs are gathered from every window into one group per container.
- During session restore, per-tab handling is paused for ~12 s (with a few
  delayed reconciles) so Firefox finishes re-creating windows, tabs and groups
  before the extension moves anything.

The only time a tab *isn't* pulled into its container's window is when that
would empty Firefox's last remaining window.

**Site routing**

- A blocking `webRequest.onBeforeRequest` listener watches top-level
  (`main_frame`) navigations.
- If the URL matches a rule and the tab isn't already in the rule's container,
  the tab is reopened via `tabs.create({ cookieStoreId })` and the old one is
  closed. A short-lived per-URL guard prevents reopen loops.
- Matching an already-correct container is left alone; **any other** container
  is moved to the assigned one.

**New-tab container inheritance** (off by default)

- `tabs.onActivated` keeps a `windowId → active cookieStoreId` map.
- On `tabs.onCreated`, a blank (`about:newtab` / `about:blank` / `about:home`),
  opener-less, default-container tab is re-created with the window's active
  container and the blank one is closed.
- Links are untouched (Firefox already opens them in their opener's container),
  and a tab that already has a real URL is never disturbed.

**Tab right-click menu**

- *Always open "&lt;host&gt;" in ▸* — submenu of every container (plus "No
  container"); picking one adds a domain rule for the tab's host and reopens the
  tab there. The tab's current container is marked.
- *Stop opening "&lt;host&gt;" in a container* — shown only when a domain rule
  for that host exists; removes it.
- *Move tab to its container's group* — re-runs the grouper for that one tab
  (useful after you've dragged a tab out of its group).

**Match types (options page)**


| Type | Matches |
|---|---|
| Domain + subdomains | `example.com` also matches `www.example.com`, `a.b.example.com` |
| Exact host | only the exact hostname |
| URL glob | `*` wildcards against the full URL, e.g. `https://*.example.com/app/*` |

## Permissions

`tabs`, `tabGroups`, `contextualIdentities`, `cookies`, `storage`, `menus`,
`webRequest`, `webRequestBlocking`, and `<all_urls>` host access (needed to see
and redirect navigations for the routing feature).

## Limitations & known edge cases

- **Requires Firefox 140+.**
- Private windows are ignored (containers don't apply there).
- Pinned tabs are left alone by the grouper.
- Consolidation moves tabs between windows. A window whose last tab gets pulled
  into another window will close.
- If you manually drag a tab out of its group, the extension won't fight you
  until the next create/attach/reconcile event.
- A container renamed while the background page is cold *and* has no cached
  mapping yet may keep its old group name until the next reconcile touches it.
- "No Container" grouping is opt-in via the options page.
- Site routing reopens the tab, so it loses forward/back history for that
  navigation (same tradeoff as Mozilla's Multi-Account Containers).
- Deleting a container removes any rules that pointed at it.

## Development

```bash
npm install
npm start          # launches a scratch Firefox with the extension loaded
npm test           # unit + integration tests (node:test, no browser)
npm run lint       # web-ext lint
npm run build      # produces web-ext-artifacts/*.zip
npm run sign       # signed .xpi via AMO (needs WEB_EXT_API_KEY / _SECRET)
```

See [Install](#install) for loading it into your everyday Firefox.

### Layout

| File | Role |
|---|---|
| `core.js` | pure decision logic — no `browser` API, no mutable state |
| `background.js` | ES-module background: state, `browser` calls, event wiring |
| `options.html` / `options.js` | preferences + rule table |
| `test/core.test.js` | unit tests for `core.js` |
| `test/fake-browser.js` | in-memory fake of the WebExtension surface used here |
| `test/integration.test.js` | drives `background.js` against the fake (grouping, consolidation, routing, inheritance, rename) |

Tests import `background.js` with a cache-busting query string so each test gets
a fresh module instance and a fresh fake browser. CI (`.github/workflows/ci.yml`)
runs `npm test` and `npm run lint` on every push and PR.

## License

MIT
