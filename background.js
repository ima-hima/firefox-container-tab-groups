/**
 * Container Corral
 * ================
 *
 * Two features, both built on Firefox's native tab groups + containers:
 *
 *  1. Grouping     - keeps one native tab group per container, across all
 *                    windows. Because tab groups cannot span windows, a tab is
 *                    moved to the window that holds its container's group; if
 *                    that tab was the active one, focus follows it there.
 *
 *  2. Site routing - a list of "open this site in that container" rules. When a
 *                    top-level navigation matches a rule and the tab is in the
 *                    wrong container, the tab is reopened in the right one.
 *
 * Pure decision logic lives in core.js so it can be unit-tested without a
 * browser; this file is the wiring around it.
 */

import {
  DEFAULT_SETTINGS,
  COLOR_MAP,
  DEFAULT_STORE,
  DEFAULT_GROUP_TITLE,
  DEFAULT_GROUP_COLOR,
  normTitle,
  hostOf,
  matchRule,
  describe,
  eligible as isEligible,
  homeWindowFor,
  groupPositionMoves,
  containerToInherit,
} from "./core.js";

let settings = { ...DEFAULT_SETTINGS };

const eligible = (tab) => isEligible(tab, settings);

/* ------------------------------------------------------------------ *
 * Tiny async mutex: overlapping tab events must not race each other
 * into creating two groups for the same container.
 * ------------------------------------------------------------------ */
let queue = Promise.resolve();
function serialize(task) {
  queue = queue.then(() =>
    Promise.resolve()
      .then(task)
      .catch((err) => console.error("[CTG]", err))
  );
  return queue;
}

/* ================================================================== *
 * Shared helpers
 * ================================================================== */

async function getContainers() {
  const list = await browser.contextualIdentities.query({});
  const map = new Map();
  for (const c of list) map.set(c.cookieStoreId, c);
  return map;
}

/**
 * Reopen `tab` at `url` in `cookieStoreId`, then close the original.
 * No-op if the tab is already in that container. Returns true if it acted.
 */
async function reopenInContainer(tab, cookieStoreId, url = tab.url) {
  const current = tab.cookieStoreId || DEFAULT_STORE;
  if (current === cookieStoreId || tab.incognito || !url) return false;

  if (cookieStoreId !== DEFAULT_STORE) {
    try {
      await browser.contextualIdentities.get(cookieStoreId);
    } catch {
      return false;
    }
  }

  recentlyRouted.set(url, Date.now());
  try {
    await browser.tabs.create({
      url,
      cookieStoreId,
      windowId: tab.windowId,
      index: tab.index + 1,
      active: tab.active,
    });
    await browser.tabs.remove(tab.id);
    return true;
  } catch (err) {
    console.error("[CTG] reopen failed", err);
    recentlyRouted.delete(url);
    return false;
  }
}

/* ================================================================== *
 * Feature 1: container -> tab group
 * ================================================================== */

/**
 * cookieStoreId -> { groupId, windowId }. Persisted in storage.local so it
 * survives event-page suspension and browser restarts. This is what lets a
 * container rename reach the right group, and what stops a second same-named
 * group being spawned after the background page has been unloaded. Entries are
 * validated on use (tabGroups.get) and dropped when stale.
 */
let groupMap = {};

async function loadGroupMap() {
  try {
    const s = await browser.storage.local.get("groupMap");
    groupMap = s.groupMap || {};
  } catch {
    groupMap = {};
  }
}

async function rememberGroup(store, groupId, windowId) {
  const prev = groupMap[store];
  if (prev && prev.groupId === groupId && prev.windowId === windowId) return;
  groupMap[store] = { groupId, windowId };
  try {
    await browser.storage.local.set({ groupMap });
  } catch {
    /* storage unavailable; fall back to in-memory only */
  }
}

async function forgetGroup(store) {
  if (!groupMap[store]) return;
  delete groupMap[store];
  try {
    await browser.storage.local.set({ groupMap });
  } catch {
    /* ignore */
  }
}

/** Set of ids of normal, non-incognito windows. */
async function normalWindowIds() {
  const wins = await browser.windows.getAll({ windowTypes: ["normal"] });
  return new Set(wins.filter((w) => !w.incognito).map((w) => w.id));
}

/**
 * The canonical group for `desc` across all normal windows, as
 * { groupId, windowId }, or null if none exists.
 *
 * Several groups can share the name: a per-window group in each of several
 * windows, or a session-restore duplicate. The oldest group id wins as
 * canonical. Duplicates in the SAME window as the canonical group are merged
 * into it now; cross-window duplicates are drained by reconcile (which we nudge).
 */
async function findContainerGroup(store, desc, winIds) {
  // 1. Trust the remembered mapping if it still points at a live group.
  const remembered = groupMap[store];
  if (remembered != null) {
    try {
      const g = await browser.tabGroups.get(remembered.groupId);
      if (winIds.has(g.windowId)) {
        if (g.windowId !== remembered.windowId) {
          await rememberGroup(store, g.id, g.windowId);
        }
        return { groupId: g.id, windowId: g.windowId };
      }
    } catch {
      await forgetGroup(store);
    }
  }

  // 2. Otherwise match by (normalised) title across every normal window.
  const key = normTitle(desc.title);
  if (!key) return null;

  const groups = (await browser.tabGroups.query({})).filter(
    (g) => normTitle(g.title) === key && winIds.has(g.windowId)
  );
  if (groups.length === 0) return null;
  groups.sort((a, b) => a.id - b.id);
  const canonical = groups[0];

  let sameWindowDupes = 0;
  let crossWindowDupes = 0;
  for (const g of groups.slice(1)) {
    if (g.windowId === canonical.windowId) {
      sameWindowDupes++;
      const t = await browser.tabs.query({ groupId: g.id });
      if (t.length) {
        await browser.tabs.group({
          groupId: canonical.id,
          tabIds: t.map((x) => x.id),
        });
      }
    } else {
      crossWindowDupes++;
    }
  }
  if (crossWindowDupes > 0) scheduleReconcile();

  await rememberGroup(store, canonical.id, canonical.windowId);
  return { groupId: canonical.id, windowId: canonical.windowId };
}

/** Name/colour a group. `force` names even when the sync setting is off. */
async function setGroupMeta(groupId, desc, force = false) {
  if (!force && !settings.syncTitleAndColor) return;
  try {
    const g = await browser.tabGroups.get(groupId);
    if (g.title !== desc.title || g.color !== desc.color) {
      await browser.tabGroups.update(groupId, {
        title: desc.title,
        color: desc.color,
      });
    }
  } catch {
    /* group vanished between calls; next reconcile will fix it */
  }
}

/**
 * Move `tab` into `groupWindowId`. Skipped only when it would empty the very
 * last window (Firefox would have nowhere to put the browser). Consolidating a
 * lone tab out of one of several windows is fine — the empty window closes,
 * which is the point. Returns the window the tab ended up in.
 */
async function moveTabToWindow(tab, groupWindowId, windowCount) {
  if (tab.windowId === groupWindowId) return tab.windowId;
  if (windowCount <= 1) return tab.windowId;
  await browser.tabs.move(tab.id, { windowId: groupWindowId, index: -1 });
  return groupWindowId;
}

/**
 * Slide `tabIds` (already members of `groupId`) to the configured end of the
 * group, keeping their relative order. The group's span doesn't change, so the
 * anchor index is stable across the individual moves.
 */
async function positionInGroup(tabIds, groupId) {
  const groupTabs = await browser.tabs.query({ groupId });
  const plan = groupPositionMoves(
    groupTabs,
    tabIds,
    settings.newTabPosition === "leftmost"
  );
  if (!plan) return;
  for (const id of plan.orderedIds) {
    try {
      await browser.tabs.move(id, { index: plan.anchor });
    } catch {
      /* tab moved/closed underneath us; ignore */
    }
  }
}

async function createGroupInWindow(store, tabIds, windowId, desc) {
  const groupId = await browser.tabs.group({
    tabIds,
    createProperties: { windowId },
  });
  await rememberGroup(store, groupId, windowId);
  await setGroupMeta(groupId, desc, true);
  return groupId;
}

async function placeTab(tabId) {
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return;
  }
  if (!tab || !eligible(tab) || tab.incognito) return;

  const originWindow = tab.windowId;
  const wasActive = tab.active;

  const containers = await getContainers();
  const store = tab.cookieStoreId || DEFAULT_STORE;
  const desc = describe(store, containers);
  if (!desc) return;

  // Already in a correctly-named group? Adopt it and stop.
  if (typeof tab.groupId === "number" && tab.groupId >= 0) {
    try {
      const g = await browser.tabGroups.get(tab.groupId);
      if (normTitle(g.title) === normTitle(desc.title)) {
        await rememberGroup(store, g.id, g.windowId);
        await setGroupMeta(g.id, desc);
        return;
      }
    } catch {
      /* fall through */
    }
  }

  const winIds = await normalWindowIds();
  const target = await findContainerGroup(store, desc, winIds);

  if (target == null) {
    await createGroupInWindow(store, [tabId], tab.windowId, desc);
    return;
  }

  const landed = await moveTabToWindow(tab, target.windowId, winIds.size);
  if (landed !== target.windowId) {
    // Only reachable when this is the last window -> keep a local group.
    await createGroupInWindow(store, [tabId], tab.windowId, desc);
    return;
  }

  const fresh = await browser.tabs.get(tabId);
  if (fresh.groupId !== target.groupId) {
    await browser.tabs.group({ groupId: target.groupId, tabIds: [tabId] });
    await positionInGroup([tabId], target.groupId);
  }
  await rememberGroup(store, target.groupId, target.windowId);
  await setGroupMeta(target.groupId, desc);

  // If we pulled the tab out of the window the user was looking at, follow it:
  // raise the destination window and select the tab there.
  if (landed !== originWindow && wasActive) {
    try {
      await browser.tabs.update(tabId, { active: true });
      await browser.windows.update(target.windowId, { focused: true });
    } catch {
      /* window/tab gone; not worth chasing */
    }
  }
}

async function reconcileAll() {
  const wins = (
    await browser.windows.getAll({ windowTypes: ["normal"] })
  ).filter((w) => !w.incognito);
  const winIds = new Set(wins.map((w) => w.id));
  const containers = await getContainers();

  // eligible tabs bucketed by store, across every normal window
  const byStore = new Map();
  for (const w of wins) {
    for (const tab of await browser.tabs.query({ windowId: w.id })) {
      if (!eligible(tab)) continue;
      const store = tab.cookieStoreId || DEFAULT_STORE;
      if (!byStore.has(store)) byStore.set(store, []);
      byStore.get(store).push(tab);
    }
  }

  for (const [store, tabs] of byStore) {
    const desc = describe(store, containers);
    if (!desc) continue;

    let groupId;
    let groupWindowId;

    const target = await findContainerGroup(store, desc, winIds);
    if (target) {
      groupId = target.groupId;
      groupWindowId = target.windowId;
    } else {
      groupWindowId = homeWindowFor(tabs);
      const seed = tabs
        .filter((t) => t.windowId === groupWindowId)
        .map((t) => t.id);
      groupId = await createGroupInWindow(store, seed, groupWindowId, desc);
    }

    for (const t of tabs) {
      await moveTabToWindow(t, groupWindowId, winIds.size);
    }

    // group everything for this store that now sits in the group's window
    const here = await browser.tabs.query({ windowId: groupWindowId });
    const ids = here
      .filter((t) => {
        const s = t.cookieStoreId || DEFAULT_STORE;
        return eligible(t) && s === store && t.groupId !== groupId;
      })
      .map((t) => t.id);
    if (ids.length) {
      await browser.tabs.group({ groupId, tabIds: ids });
      await positionInGroup(ids, groupId);
    }
    await setGroupMeta(groupId, desc);
  }
}

/** Re-apply titles/colours after a container is renamed or recoloured. */
async function syncAllGroupMeta() {
  if (!settings.syncTitleAndColor) return;
  const containers = await getContainers();
  const winIds = await normalWindowIds();

  for (const c of containers.values()) {
    const desc = { title: c.name, color: COLOR_MAP[c.color] || "grey" };
    const target = await findContainerGroup(c.cookieStoreId, desc, winIds);
    if (target) await setGroupMeta(target.groupId, desc, true);
  }
  const defDesc = { title: DEFAULT_GROUP_TITLE, color: DEFAULT_GROUP_COLOR };
  const defTarget = await findContainerGroup(DEFAULT_STORE, defDesc, winIds);
  if (defTarget) await setGroupMeta(defTarget.groupId, defDesc, true);
}

/* ================================================================== *
 * Feature 2: site -> container routing
 * ================================================================== */

// [{ id, pattern, matchType: "domain"|"exact"|"glob", cookieStoreId, enabled }]
let rules = [];

async function loadRules() {
  const stored = await browser.storage.local.get("containerRules");
  rules = Array.isArray(stored.containerRules) ? stored.containerRules : [];
}

// Guard against re-handling the tab we just opened for a given navigation.
const recentlyRouted = new Map(); // url -> timestamp
const ROUTE_TTL_MS = 4000;

function wasJustRouted(url) {
  const t = recentlyRouted.get(url);
  if (t == null) return false;
  if (Date.now() - t > ROUTE_TTL_MS) {
    recentlyRouted.delete(url);
    return false;
  }
  return true;
}

async function handleRequest(details) {
  if (details.tabId < 0 || details.frameId !== 0) return {};

  const rule = matchRule(details.url, rules);
  if (!rule) return {};
  if (wasJustRouted(details.url)) return {};

  let tab;
  try {
    tab = await browser.tabs.get(details.tabId);
  } catch {
    return {};
  }

  const acted = await reopenInContainer(tab, rule.cookieStoreId, details.url);
  return acted ? { cancel: true } : {};
}

browser.webRequest.onBeforeRequest.addListener(
  handleRequest,
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["blocking"]
);

/* ================================================================== *
 * Settings + rules storage
 * ================================================================== */

async function loadSettings() {
  const stored = await browser.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    serialize(reconcileAll);
  }
  if (changes.containerRules) {
    rules = Array.isArray(changes.containerRules.newValue)
      ? changes.containerRules.newValue
      : [];
  }
});

async function persistRules(next) {
  rules = next;
  await browser.storage.local.set({ containerRules: rules });
}

/* ================================================================== *
 * Feature 3: tab context menu
 * ================================================================== */

const MENU_ASSIGN = "ctg-assign";
const MENU_UNASSIGN = "ctg-unassign";
const MENU_REGROUP = "ctg-regroup";

function domainRuleFor(host) {
  const lower = host.toLowerCase();
  return rules.find(
    (r) => r.matchType === "domain" && r.pattern.trim().toLowerCase() === lower
  );
}

async function containerEntries() {
  const list = await browser.contextualIdentities.query({});
  return [
    { cookieStoreId: DEFAULT_STORE, name: "No container" },
    ...list.map((c) => ({ cookieStoreId: c.cookieStoreId, name: c.name })),
  ];
}

async function buildMenus() {
  await browser.menus.removeAll();

  browser.menus.create({
    id: MENU_ASSIGN,
    title: "Always open this site in…",
    contexts: ["tab"],
  });
  for (const e of await containerEntries()) {
    browser.menus.create({
      id: `${MENU_ASSIGN}:${e.cookieStoreId}`,
      parentId: MENU_ASSIGN,
      title: e.name,
      type: "radio",
      checked: false,
      contexts: ["tab"],
    });
  }

  browser.menus.create({
    id: MENU_UNASSIGN,
    title: "Stop opening this site in a container",
    contexts: ["tab"],
    visible: false,
  });

  browser.menus.create({
    id: "ctg-sep",
    type: "separator",
    contexts: ["tab"],
  });
  browser.menus.create({
    id: MENU_REGROUP,
    title: "Move tab to its container’s group",
    contexts: ["tab"],
  });
}

browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.contexts.includes("tab") || !tab) return;

  const host = hostOf(tab.url);
  const store = tab.cookieStoreId || DEFAULT_STORE;

  try {
    await browser.menus.update(MENU_ASSIGN, {
      enabled: Boolean(host),
      title: host ? `Always open “${host}” in…` : "Always open this site in…",
    });

    for (const e of await containerEntries()) {
      await browser.menus.update(`${MENU_ASSIGN}:${e.cookieStoreId}`, {
        checked: e.cookieStoreId === store,
      });
    }

    await browser.menus.update(MENU_UNASSIGN, {
      visible: Boolean(host && domainRuleFor(host)),
      title: host
        ? `Stop opening “${host}” in a container`
        : "Stop opening this site in a container",
    });
  } catch {
    // Menu items briefly out of sync (event page just woke, container just
    // added/removed). buildMenus() will rebuild; nothing to do here.
    return;
  }

  browser.menus.refresh();
});

browser.menus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const id = info.menuItemId;

  if (id === MENU_REGROUP) {
    serialize(() => placeTab(tab.id));
    return;
  }

  const host = hostOf(tab.url);
  if (!host) return;

  if (id === MENU_UNASSIGN) {
    serialize(() =>
      persistRules(rules.filter((r) => r !== domainRuleFor(host)))
    );
    return;
  }

  if (typeof id === "string" && id.startsWith(`${MENU_ASSIGN}:`)) {
    const cookieStoreId = id.slice(MENU_ASSIGN.length + 1);
    serialize(async () => {
      const existing = domainRuleFor(host);
      const next = rules.filter((r) => r !== existing);
      next.push({
        id: crypto.randomUUID(),
        pattern: host,
        matchType: "domain",
        cookieStoreId,
        enabled: true,
      });
      await persistRules(next);
      await reopenInContainer(tab, cookieStoreId);
    });
  }
});

/* ================================================================== *
 * Feature 4: inherit the current tab's container for blank new tabs
 * ================================================================== */

// windowId -> cookieStoreId of the currently-active tab. onCreated fires before
// onActivated, so when a foreground new tab appears this still holds the tab the
// user was on.
const activeStore = new Map();

async function trackActive(windowId, tabId) {
  try {
    const t = await browser.tabs.get(tabId);
    activeStore.set(windowId, t.cookieStoreId || DEFAULT_STORE);
  } catch {
    /* tab gone */
  }
}

async function maybeInheritContainer(newTab, inheritFrom) {
  const target = containerToInherit(newTab, {
    enabled: settings.newTabInheritsContainer,
    now: Date.now(),
    settleUntil,
    inheritFrom,
  });
  if (!target) return;

  try {
    await browser.contextualIdentities.get(target);
  } catch {
    return;
  }

  try {
    await browser.tabs.create({
      cookieStoreId: target,
      windowId: newTab.windowId,
      index: newTab.index,
      active: newTab.active,
    });
    await browser.tabs.remove(newTab.id);
  } catch (err) {
    console.error("[CTG] inherit-container failed", err);
  }
}

/* ================================================================== *
 * Event wiring
 * ================================================================== */

// Coalesce bursts of triggers into a single reconcile.
let reconcileTimer = null;
function scheduleReconcile(delay = 500) {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    serialize(reconcileAll);
  }, delay);
  reconcileTimer.unref?.(); // don't hold Node alive under test
}

// During session restore, Firefox creates tabs and re-creates their groups in
// no fixed order. Acting on each tab as it appears would race group restoration
// and spawn duplicates, so for a short window we only do (debounced) full
// reconciles, which merge by title.
let settleUntil = 0;
function onTabSettled(tabId) {
  if (Date.now() < settleUntil) {
    scheduleReconcile(1500);
    return;
  }
  serialize(() => placeTab(tabId));
}

browser.runtime.onInstalled.addListener(() => serialize(reconcileAll));
browser.runtime.onStartup.addListener(() => {
  // Let session restore finish re-creating windows/tabs/groups before we start
  // moving things around, then reconcile a couple of times as it settles.
  settleUntil = Date.now() + 12000;
  for (const delay of [1500, 5000, 12000]) {
    setTimeout(() => serialize(reconcileAll), delay).unref?.();
  }
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  trackActive(windowId, tabId);
});

browser.tabs.onCreated.addListener((tab) => {
  // Read the pre-existing active container synchronously, before onActivated
  // for this new tab can overwrite it.
  const inheritFrom = activeStore.get(tab.windowId);
  if (settings.newTabInheritsContainer) {
    serialize(() => maybeInheritContainer(tab, inheritFrom));
  }
  onTabSettled(tab.id);
});
browser.tabs.onAttached.addListener((tabId) => onTabSettled(tabId));

browser.contextualIdentities.onCreated.addListener(() =>
  serialize(buildMenus)
);
browser.contextualIdentities.onUpdated.addListener(() =>
  serialize(async () => {
    await syncAllGroupMeta();
    await buildMenus();
  })
);
browser.contextualIdentities.onRemoved.addListener((info) =>
  serialize(async () => {
    const csid = info.contextualIdentity.cookieStoreId;
    await forgetGroup(csid);
    const kept = rules.filter((r) => r.cookieStoreId !== csid);
    if (kept.length !== rules.length) {
      await persistRules(kept);
    }
    await buildMenus();
    await reconcileAll();
  })
);

browser.tabGroups.onRemoved.addListener((group) =>
  serialize(async () => {
    for (const [store, entry] of Object.entries(groupMap)) {
      if (entry.groupId === group.id) await forgetGroup(store);
    }
  })
);

/* ================================================================== *
 * Boot
 * ================================================================== */

const ready = serialize(async () => {
  await Promise.all([loadSettings(), loadRules(), loadGroupMap()]);
  await buildMenus();
  for (const t of await browser.tabs.query({ active: true })) {
    activeStore.set(t.windowId, t.cookieStoreId || DEFAULT_STORE);
  }
});

// Deferred so that, on a cold browser start, session restore has a moment to
// finish before the first reconcile. Mid-session wake-ups just reconcile ~2s
// later. Tests import this module and drive functions directly, so they opt out.
if (!globalThis.__CTG_TEST__) {
  scheduleReconcile(2000);
}

/* ------------------------------------------------------------------ *
 * Test surface — used by test/*.test.js, ignored by the extension.
 * ------------------------------------------------------------------ */
export {
  ready,
  placeTab,
  reconcileAll,
  syncAllGroupMeta,
  handleRequest,
  maybeInheritContainer,
  buildMenus,
  trackActive,
  activeStore,
};
export function __setSettleUntil(t) {
  settleUntil = t;
}
