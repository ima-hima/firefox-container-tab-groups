# Container Tab Groups

A small Firefox extension that keeps **one native tab group per
Multi-Account Container, per window**. Open a tab in your "Work" container and
it lands in the "Work" tab group; open one in "Shopping" and it goes to
"Shopping". The group's name and colour follow the container.

This is a from-scratch alternative to
[Simple Tab Groups](https://github.com/Drive4ik/simple-tab-groups): rather than
implementing its own group system, it just drives Firefox's built-in tab groups
via the `tabGroups` WebExtension API (Firefox 139+).

## How it works

- `contextualIdentities.query()` + `tab.cookieStoreId` identify a tab's container.
- On tab create / attach, the tab is moved into the group matching its container
  for that window (`tabs.group()`), creating the group if needed.
- Group title/colour are synced from the container (`tabGroups.update()`), and
  re-synced when a container is renamed or recoloured.
- On startup / install / container removal, all windows are reconciled.

Tab groups can't span windows, so each window gets its own group per container.

## Limitations & known edge cases

- **Requires Firefox 139+** (the `tabGroups` API).
- Private windows are ignored (containers don't apply there).
- Pinned tabs are left alone.
- If you manually drag a tab out of its group, the extension won't fight you
  until the next create/attach/reconcile event.
- "No Container" grouping is opt-in via the options page.
- No handling yet for a tab whose container is changed in place by another
  extension (Firefox reopens the tab, which fires `onCreated`, so this usually
  works anyway).

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
