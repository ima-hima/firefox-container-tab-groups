"use strict";

/**
 * Container Tab Groups
 * ====================
 *
 * Keeps exactly one native Firefox tab group per container, per window.
 * Whenever a tab is created in — or moved into — a window, it is placed in
 * the tab group that corresponds to its contextual identity (cookieStoreId).
 *
 * Firefox tab groups cannot span windows, but containers are global, so the
 * unit of grouping is (window, container).
 */

const DEFAULT_SETTINGS = {
  // Also group tabs that have no container (the "firefox-default" store).
  groupDefaultContainer: false,
  // Keep each group's title and colour matched to its container.
  syncTitleAndColor: true,
};

// contextualIdentities colours -> tabGroups.Color values
const COLOR_MAP = {
  blue: "blue",
  turquoise: "cyan",
  green: "green",
  yellow: "yellow",
  orange: "orange",
  red: "red",
  pink: "pink",
  purple: "purple",
  toolbar: "grey",
};

const DEFAULT_STORE = "firefox-default";
const DEFAULT_GROUP_TITLE = "No Container";
const DEFAULT_GROUP_COLOR = "grey";

let settings = { ...DEFAULT_SETTINGS };

// windowId -> Map(cookieStoreId -> groupId)
const groupIndex = new Map();

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

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function getContainers() {
  const list = await browser.contextualIdentities.query({});
  const map = new Map();
  for (const c of list) map.set(c.cookieStoreId, c);
  return map;
}

/** Target group title/colour for a given cookieStoreId, or null to skip. */
function describe(cookieStoreId, containers) {
  if (cookieStoreId === DEFAULT_STORE) {
    return { title: DEFAULT_GROUP_TITLE, color: DEFAULT_GROUP_COLOR };
  }
  const c = containers.get(cookieStoreId);
  if (!c) return null;
  return { title: c.name, color: COLOR_MAP[c.color] || "grey" };
}

function eligible(tab) {
  if (tab.pinned) return false;
  const store = tab.cookieStoreId || DEFAULT_STORE;
  if (store.startsWith("firefox-private")) return false;
  if (store === DEFAULT_STORE && !settings.groupDefaultContainer) return false;
  return true;
}

function indexFor(windowId) {
  let perWindow = groupIndex.get(windowId);
  if (!perWindow) {
    perWindow = new Map();
    groupIndex.set(windowId, perWindow);
  }
  return perWindow;
}

/** Find an existing group for (window, container); returns groupId or null. */
async function resolveGroup(windowId, cookieStoreId, desc) {
  const perWindow = indexFor(windowId);

  const cached = perWindow.get(cookieStoreId);
  if (cached != null) {
    try {
      await browser.tabGroups.get(cached);
      return cached;
    } catch {
      perWindow.delete(cookieStoreId);
    }
  }

  // Fall back to matching a group in this window by title (e.g. after restart).
  const existing = await browser.tabGroups.query({ windowId });
  for (const g of existing) {
    if (g.title === desc.title) {
      perWindow.set(cookieStoreId, g.id);
      return g.id;
    }
  }
  return null;
}

async function applyMeta(groupId, desc) {
  if (!settings.syncTitleAndColor) return;
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

/* ------------------------------------------------------------------ *
 * Core operations
 * ------------------------------------------------------------------ */

async function placeTab(tabId) {
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return;
  }
  if (!eligible(tab)) return;

  const containers = await getContainers();
  const store = tab.cookieStoreId || DEFAULT_STORE;
  const desc = describe(store, containers);
  if (!desc) return;

  let groupId = await resolveGroup(tab.windowId, store, desc);

  if (groupId == null) {
    groupId = await browser.tabs.group({
      tabIds: [tabId],
      createProperties: { windowId: tab.windowId },
    });
    indexFor(tab.windowId).set(store, groupId);
  } else if (tab.groupId !== groupId) {
    await browser.tabs.group({ groupId, tabIds: [tabId] });
  }

  await applyMeta(groupId, desc);
}

async function reconcileAll() {
  groupIndex.clear();

  const wins = await browser.windows.getAll({
    populate: true,
    windowTypes: ["normal"],
  });
  const containers = await getContainers();

  for (const win of wins) {
    if (win.incognito) continue;

    const byStore = new Map();
    for (const tab of win.tabs) {
      if (!eligible(tab)) continue;
      const store = tab.cookieStoreId || DEFAULT_STORE;
      if (!byStore.has(store)) byStore.set(store, []);
      byStore.get(store).push(tab);
    }

    for (const [store, tabs] of byStore) {
      const desc = describe(store, containers);
      if (!desc) continue;

      let groupId = await resolveGroup(win.id, store, desc);
      if (groupId == null) {
        groupId = await browser.tabs.group({
          tabIds: tabs.map((t) => t.id),
          createProperties: { windowId: win.id },
        });
        indexFor(win.id).set(store, groupId);
      } else {
        const stray = tabs
          .filter((t) => t.groupId !== groupId)
          .map((t) => t.id);
        if (stray.length) {
          await browser.tabs.group({ groupId, tabIds: stray });
        }
      }
      await applyMeta(groupId, desc);
    }
  }
}

async function syncAllGroupMeta() {
  if (!settings.syncTitleAndColor) return;
  const containers = await getContainers();
  for (const [, perWindow] of groupIndex) {
    for (const [store, groupId] of perWindow) {
      const desc = describe(store, containers);
      if (desc) await applyMeta(groupId, desc);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

async function loadSettings() {
  const stored = await browser.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  serialize(reconcileAll);
});

/* ------------------------------------------------------------------ *
 * Event wiring
 * ------------------------------------------------------------------ */

browser.runtime.onInstalled.addListener(() => serialize(reconcileAll));
browser.runtime.onStartup.addListener(() => serialize(reconcileAll));

browser.tabs.onCreated.addListener((tab) => serialize(() => placeTab(tab.id)));
browser.tabs.onAttached.addListener((tabId) => serialize(() => placeTab(tabId)));

browser.contextualIdentities.onUpdated.addListener(() =>
  serialize(syncAllGroupMeta)
);
browser.contextualIdentities.onRemoved.addListener(() =>
  serialize(reconcileAll)
);

browser.windows.onRemoved.addListener((windowId) => {
  groupIndex.delete(windowId);
});

browser.tabGroups.onRemoved.addListener((group) => {
  const perWindow = groupIndex.get(group.windowId);
  if (!perWindow) return;
  for (const [store, id] of perWindow) {
    if (id === group.id) perWindow.delete(store);
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

serialize(async () => {
  await loadSettings();
  await reconcileAll();
});
