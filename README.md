# Container Tab Groups

A small Firefox extension with two related features, both built on Firefox's
native tab groups (Firefox 140+) and Multi-Account Containers:

1. **Group tabs by container.** One native tab group per container, per window.
   Open a tab in your "Work" container and it lands in the "Work" tab group;
   open one in "Shopping" and it goes to "Shopping". The group's name and colour
   follow the container.
2. **Open sites in a container.** A list of `site → container` rules. When you
   open a matching site, the tab is reopened in the chosen container (and so
   lands in that container's group). Rules can be added from the options page or
   straight from the tab's right-click menu.

This is a from-scratch alternative to
[Simple Tab Groups](https://github.com/Drive4ik/simple-tab-groups): rather than
implementing its own group system, it just drives Firefox's built-in tab groups
via the `tabGroups` WebExtension API.

## How it works

**Grouping**

- `contextualIdentities.query()` + `tab.cookieStoreId` identify a tab's container.
- On tab create / attach, the tab is moved into the group matching its container
  for that window (`tabs.group()`), creating the group if needed.
- Group title/colour are synced from the container (`tabGroups.update()`), and
  re-synced when a container is renamed or recoloured.
- On startup / install / container removal, all windows are reconciled.

Tab groups can't span windows, so each window gets its own group per container.

**Site routing**

- A blocking `webRequest.onBeforeRequest` listener watches top-level
  (`main_frame`) navigations.
- If the URL matches a rule and the tab isn't already in the rule's container,
  the tab is reopened via `tabs.create({ cookieStoreId })` and the old one is
  closed. A short-lived per-URL guard prevents reopen loops.
- Matching an already-correct container is left alone; **any other** container
  is moved to the assigned one.

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
- If you manually drag a tab out of its group, the extension won't fight you
  until the next create/attach/reconcile event.
- "No Container" grouping is opt-in via the options page.
- Site routing reopens the tab, so it loses forward/back history for that
  navigation (same tradeoff as Mozilla's Multi-Account Containers).
- Deleting a container removes any rules that pointed at it.

## Development

```bash
npm install
npm start          # launches Firefox with the extension loaded (web-ext run)
npm run lint       # web-ext lint
npm run build      # produces web-ext-artifacts/*.zip
```

Or load it unpacked: `about:debugging` → This Firefox → Load Temporary Add-on →
pick `manifest.json`.

## License

MIT
