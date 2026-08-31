"use strict";

/**
 * Container Tab Groups
 * ====================
 *
 * Two features, both built on Firefox's native tab groups + containers:
 *
 *  1. Grouping     - keeps exactly one native tab group per container, per
 *                    window. Tabs created in / moved into a window are placed
 *                    in the group for their contextual identity.
 *
 *  2. Site routing - a list of "open this site in that container" rules. When a
 *                    top-level navigation matches a rule and the tab is in the
 *                    wrong container, the tab is reopened in the right one.
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

/* ================================================================== *
 * Shared helpers
 * ================================================================== */

async function getContainers() {
  const list = await browser.contextualIdentities.query({});
  const map = new Map();
  for (const c of list) map.set(c.cookieStoreId, c);
  return map;
}

/** hostname for http(s) URLs, else null. */
function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname;
  } catch {
    return null;
  }
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

const normTitle = (s) => (s || "").trim().toLowerCase();

/**
 * The id of the group in `windowId` whose title matches `title`, or null.
 * If several groups share the title (e.g. a session-restore race created a
 * duplicate), their tabs are merged into the oldest and that id is returned.
 */
async function findGroupByTitle(windowId, title) {
  const key = normTitle(title);
  if (!key) return null;

  const groups = await browser.tabGroups.query({ windowId });
  const matches = groups
    .filter((g) => normTitle(g.title) === key)
    .sort((a, b) => a.id - b.id);
  if (matches.length === 0) return null;

  const keep = matches[0];
  for (const dupe of matches.slice(1)) {
    const dupeTabs = await browser.tabs.query({ groupId: dupe.id });
    if (dupeTabs.length) {
      await browser.tabs.group({
        groupId: keep.id,
        tabIds: dupeTabs.map((t) => t.id),
      });
    }
  }
  return keep.id;
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

  // Match (and de-duplicate) an existing group in this window by title. The
  // in-memory cache is empty after every event-page suspension, so this is the
  // real safeguard against spawning a second group with the same name.
  const found = await findGroupByTitle(windowId, desc.title);
  if (found != null) perWindow.set(cookieStoreId, found);
  return found;
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

  // Already in a group whose name matches the container? Adopt it as-is.
  if (typeof tab.groupId === "number" && tab.groupId >= 0) {
    try {
      const current = await browser.tabGroups.get(tab.groupId);
      if (normTitle(current.title) === normTitle(desc.title)) {
        indexFor(tab.windowId).set(store, current.id);
        await setGroupMeta(current.id, desc);
        return;
      }
    } catch {
      /* fall through and resolve normally */
    }
  }

  let groupId = await resolveGroup(tab.windowId, store, desc);

  if (groupId == null) {
    groupId = await browser.tabs.group({
      tabIds: [tabId],
      createProperties: { windowId: tab.windowId },
    });
    indexFor(tab.windowId).set(store, groupId);
    await setGroupMeta(groupId, desc, true);
  } else {
    if (tab.groupId !== groupId) {
      await browser.tabs.group({ groupId, tabIds: [tabId] });
    }
    await setGroupMeta(groupId, desc);
  }
}

async function reconcileAll() {
  groupIndex.clear();

  const wins = await browser.windows.getAll({ windowTypes: ["normal"] });
  const containers = await getContainers();

  for (const win of wins) {
    if (win.incognito) continue;

    const tabs = await browser.tabs.query({ windowId: win.id });
    const byStore = new Map();
    for (const tab of tabs) {
      if (!eligible(tab)) continue;
      const store = tab.cookieStoreId || DEFAULT_STORE;
      if (!byStore.has(store)) byStore.set(store, []);
      byStore.get(store).push(tab);
    }

    for (const [store, storeTabs] of byStore) {
      const desc = describe(store, containers);
      if (!desc) continue;

      // resolveGroup merges any same-named duplicates before returning.
      let groupId = await resolveGroup(win.id, store, desc);
      if (groupId == null) {
        groupId = await browser.tabs.group({
          tabIds: storeTabs.map((t) => t.id),
          createProperties: { windowId: win.id },
        });
        indexFor(win.id).set(store, groupId);
        await setGroupMeta(groupId, desc, true);
      } else {
        // Re-query: some of these tabs may have just been merged in above.
        const fresh = await browser.tabs.query({ windowId: win.id });
        const stray = fresh
          .filter((t) => {
            const s = t.cookieStoreId || DEFAULT_STORE;
            return eligible(t) && s === store && t.groupId !== groupId;
          })
          .map((t) => t.id);
        if (stray.length) {
          await browser.tabs.group({ groupId, tabIds: stray });
        }
        await setGroupMeta(groupId, desc);
      }
    }
  }
}

async function syncAllGroupMeta() {
  if (!settings.syncTitleAndColor) return;
  const containers = await getContainers();
  for (const [, perWindow] of groupIndex) {
    for (const [store, groupId] of perWindow) {
      const desc = describe(store, containers);
      if (desc) await setGroupMeta(groupId, desc);
    }
  }
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob) {
  const body = glob.split("*").map(escapeRegExp).join(".*");
  return new RegExp("^" + body + "$", "i");
}

function hostMatches(host, rule) {
  const p = rule.pattern.trim().toLowerCase().replace(/^\*\./, "");
  const h = host.toLowerCase();
  if (rule.matchType === "exact") return h === p;
  return h === p || h.endsWith("." + p); // "domain": host + subdomains
}

/** Returns the first enabled rule that matches `url`, or null. */
function matchRule(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  for (const rule of rules) {
    if (rule.enabled === false || !rule.pattern) continue;
    if (rule.matchType === "glob") {
      if (globToRegExp(rule.pattern).test(url)) return rule;
    } else if (hostMatches(u.hostname, rule)) {
      return rule;
    }
  }
  return null;
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

  const rule = matchRule(details.url);
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
  settleUntil = Date.now() + 12000;
  serialize(reconcileAll);
  setTimeout(() => serialize(reconcileAll), 3000);
  setTimeout(() => serialize(reconcileAll), 11000);
});

browser.tabs.onCreated.addListener((tab) => onTabSettled(tab.id));
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
    const kept = rules.filter((r) => r.cookieStoreId !== csid);
    if (kept.length !== rules.length) {
      await persistRules(kept);
    }
    await buildMenus();
    await reconcileAll();
  })
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

/* ================================================================== *
 * Boot
 * ================================================================== */

serialize(async () => {
  await Promise.all([loadSettings(), loadRules()]);
  await buildMenus();
  await reconcileAll();
});
