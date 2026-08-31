/**
 * A small in-memory fake of the slice of the WebExtension API that
 * background.js uses. Faithful enough for the grouping / routing / new-tab
 * logic: tabs carry a per-window `index`, `tabs.group()` makes a group's
 * members contiguous, moving a tab to another window drops it from its group,
 * and groups with no members disappear (as Firefox does).
 */

const noop = () => {};
const listener = () => {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    removeListener: (fn) => {
      const i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    },
    hasListener: (fn) => fns.includes(fn),
    _fns: fns,
  };
};

export function makeFakeBrowser(init = {}) {
  const state = {
    nextTabId: 1,
    nextGroupId: 1,
    tabs: [], // ordered; per-window order == tab order in this array
    groups: [], // { id, title, color, windowId, collapsed }
    incognitoWindows: new Set(init.incognitoWindows || []),
    containers: new Map(), // cookieStoreId -> { cookieStoreId, name, color }
    storageLocal: { ...(init.storageLocal || {}) },
    focusedWindowId: null,
  };

  for (const c of init.containers || []) {
    state.containers.set(c.cookieStoreId, { color: "blue", ...c });
  }

  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

  function reindex() {
    const perWindow = new Map();
    for (const t of state.tabs) {
      const n = perWindow.get(t.windowId) || 0;
      t.index = n;
      perWindow.set(t.windowId, n + 1);
    }
  }

  function dropEmptyGroups() {
    state.groups = state.groups.filter((g) =>
      state.tabs.some((t) => t.groupId === g.id)
    );
  }

  function windowTabs(windowId) {
    return state.tabs.filter((t) => t.windowId === windowId);
  }

  function addTab(props) {
    const tab = {
      id: state.nextTabId++,
      windowId: props.windowId ?? 1,
      cookieStoreId: props.cookieStoreId || "firefox-default",
      groupId: -1,
      active: Boolean(props.active),
      pinned: Boolean(props.pinned),
      incognito: state.incognitoWindows.has(props.windowId ?? 1),
      url: props.url ?? "about:newtab",
      openerTabId: props.openerTabId ?? null,
    };
    const wtabs = windowTabs(tab.windowId);
    let pos;
    if (props.index == null || props.index < 0 || props.index >= wtabs.length) {
      const last = wtabs[wtabs.length - 1];
      pos = last ? state.tabs.indexOf(last) + 1 : state.tabs.length;
    } else {
      pos = state.tabs.indexOf(wtabs[props.index]);
    }
    state.tabs.splice(pos, 0, tab);
    if (tab.active) {
      for (const t of wtabs) if (t !== tab) t.active = false;
    }
    reindex();
    return tab;
  }

  function removeTab(id) {
    const i = state.tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const [gone] = state.tabs.splice(i, 1);
    const siblings = windowTabs(gone.windowId);
    if (gone.active && siblings.length) siblings[0].active = true;
    reindex();
    dropEmptyGroups();
  }

  function regroupContiguously(groupId, newIds) {
    const isMember = (t) => t.groupId === groupId;
    const members = state.tabs.filter(
      (t) => isMember(t) && !newIds.includes(t.id)
    );
    const added = newIds
      .map((id) => state.tabs.find((t) => t.id === id))
      .filter(Boolean);
    const ordered = [...members, ...added];
    if (ordered.length === 0) return;
    const anchor = Math.min(...ordered.map((t) => state.tabs.indexOf(t)));
    state.tabs = state.tabs.filter((t) => !ordered.includes(t));
    state.tabs.splice(Math.min(anchor, state.tabs.length), 0, ...ordered);
    reindex();
  }

  const tabs = {
    ...listener(),
    onCreated: listener(),
    onActivated: listener(),
    onAttached: listener(),
    onUpdated: listener(),
    onRemoved: listener(),
    onMoved: listener(),

    async get(id) {
      const t = state.tabs.find((x) => x.id === id);
      if (!t) throw new Error(`no tab ${id}`);
      return clone(t);
    },

    async query(q = {}) {
      let out = state.tabs.filter((t) => {
        if (q.windowId != null && t.windowId !== q.windowId) return false;
        if (q.groupId != null && t.groupId !== q.groupId) return false;
        if (q.active != null && t.active !== q.active) return false;
        if (q.pinned != null && t.pinned !== q.pinned) return false;
        if (q.url != null && t.url !== q.url) return false;
        return true;
      });
      out = out.sort((a, b) => a.index - b.index);
      return out.map(clone);
    },

    async create(props) {
      return clone(addTab(props));
    },

    async remove(ids) {
      for (const id of Array.isArray(ids) ? ids : [ids]) removeTab(id);
    },

    async update(id, props) {
      const t = state.tabs.find((x) => x.id === id);
      if (!t) throw new Error(`no tab ${id}`);
      if (props.url != null) t.url = props.url;
      if (props.active === true) {
        for (const s of windowTabs(t.windowId)) s.active = s === t;
      }
      return clone(t);
    },

    async move(id, props) {
      const t = state.tabs.find((x) => x.id === id);
      if (!t) throw new Error(`no tab ${id}`);
      const targetWindow = props.windowId ?? t.windowId;

      if (targetWindow !== t.windowId) {
        t.groupId = -1; // groups can't span windows
        t.windowId = targetWindow;
        t.incognito = state.incognitoWindows.has(targetWindow);
      }

      state.tabs = state.tabs.filter((x) => x !== t);
      const wtabs = windowTabs(targetWindow);
      let pos;
      if (props.index == null || props.index < 0 || props.index >= wtabs.length) {
        const last = wtabs[wtabs.length - 1];
        pos = last ? state.tabs.indexOf(last) + 1 : state.tabs.length;
      } else {
        pos = state.tabs.indexOf(wtabs[props.index]);
      }
      state.tabs.splice(pos, 0, t);
      reindex();

      // Left the group's contiguous span? Firefox drops it from the group.
      if (t.groupId >= 0) {
        const span = state.tabs
          .filter((x) => x.groupId === t.groupId && x !== t)
          .map((x) => x.index);
        if (span.length && (t.index < Math.min(...span) - 1 || t.index > Math.max(...span) + 1)) {
          t.groupId = -1;
        }
      }
      dropEmptyGroups();
      return clone(t);
    },

    async group({ groupId, tabIds, createProperties }) {
      const first = state.tabs.find((t) => t.id === tabIds[0]);
      const windowId = createProperties?.windowId ?? first?.windowId ?? 1;

      if (groupId == null) {
        groupId = state.nextGroupId++;
        state.groups.push({
          id: groupId,
          title: "",
          color: "grey",
          windowId,
          collapsed: false,
        });
      }
      const group = state.groups.find((g) => g.id === groupId);

      for (const id of tabIds) {
        const t = state.tabs.find((x) => x.id === id);
        if (!t) continue;
        if (t.windowId !== group.windowId) {
          await tabs.move(id, { windowId: group.windowId, index: -1 });
        }
        t.groupId = groupId;
      }
      regroupContiguously(groupId, tabIds);
      dropEmptyGroups();
      return groupId;
    },

    async ungroup(ids) {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        const t = state.tabs.find((x) => x.id === id);
        if (t) t.groupId = -1;
      }
      dropEmptyGroups();
    },
  };

  const tabGroups = {
    onRemoved: listener(),
    onUpdated: listener(),
    onMoved: listener(),
    onCreated: listener(),

    async get(id) {
      const g = state.groups.find((x) => x.id === id);
      if (!g) throw new Error(`no group ${id}`);
      return clone(g);
    },
    async query(q = {}) {
      return state.groups
        .filter((g) => {
          if (q.windowId != null && g.windowId !== q.windowId) return false;
          if (q.title != null && g.title !== q.title) return false;
          if (q.color != null && g.color !== q.color) return false;
          if (q.collapsed != null && g.collapsed !== q.collapsed) return false;
          return true;
        })
        .map(clone);
    },
    async update(id, props) {
      const g = state.groups.find((x) => x.id === id);
      if (!g) throw new Error(`no group ${id}`);
      Object.assign(g, props);
      return clone(g);
    },
    async move() {},
  };

  const windows = {
    onRemoved: listener(),
    onCreated: listener(),
    onFocusChanged: listener(),
    async getAll() {
      const ids = [...new Set(state.tabs.map((t) => t.windowId))].sort(
        (a, b) => a - b
      );
      return ids.map((id) => ({
        id,
        incognito: state.incognitoWindows.has(id),
        type: "normal",
        focused: id === state.focusedWindowId,
      }));
    },
    async update(id, props) {
      if (props.focused) state.focusedWindowId = id;
      return { id, ...props };
    },
  };

  const contextualIdentities = {
    onCreated: listener(),
    onUpdated: listener(),
    onRemoved: listener(),
    async query() {
      return [...state.containers.values()].map(clone);
    },
    async get(id) {
      const c = state.containers.get(id);
      if (!c) throw new Error(`no container ${id}`);
      return clone(c);
    },
  };

  const storage = {
    onChanged: listener(),
    local: {
      async get(keys) {
        if (keys == null) return clone(state.storageLocal);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) {
          if (k in state.storageLocal) out[k] = clone(state.storageLocal[k]);
        }
        return out;
      },
      async set(obj) {
        Object.assign(state.storageLocal, clone(obj));
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          delete state.storageLocal[k];
        }
      },
    },
  };

  const menus = {
    onShown: listener(),
    onClicked: listener(),
    create: noop,
    update: async () => {},
    remove: async () => {},
    removeAll: async () => {},
    refresh: noop,
  };

  const browser = {
    runtime: { onInstalled: listener(), onStartup: listener(), id: "test" },
    tabs,
    tabGroups,
    windows,
    contextualIdentities,
    storage,
    menus,
    webRequest: { onBeforeRequest: listener() },
  };

  return {
    browser,
    state,
    // test helpers
    addTab: (p) => addTab(p),
    /** Fire a browser event, e.g. emit("tabs.onUpdated", tabId, changeInfo, tab). */
    emit: (path, ...args) => {
      const ev = path.split(".").reduce((o, k) => o?.[k], browser);
      if (!ev || !ev._fns) throw new Error(`no such event: ${path}`);
      for (const fn of [...ev._fns]) fn(...args);
    },
    setContainer: (c) =>
      state.containers.set(c.cookieStoreId, { color: "blue", ...c }),
    snapshotTabs: () =>
      state.tabs.map((t) => ({
        id: t.id,
        w: t.windowId,
        g: t.groupId,
        i: t.index,
        store: t.cookieStoreId,
        active: t.active,
      })),
    snapshotGroups: () =>
      state.groups.map((g) => ({ id: g.id, title: g.title, w: g.windowId, color: g.color })),
    groupTitle: (id) => state.groups.find((g) => g.id === id)?.title,
  };
}

/** Install a fresh fake as globalThis.browser and return the harness. */
export function installFakeBrowser(init) {
  const harness = makeFakeBrowser(init);
  globalThis.browser = harness.browser;
  globalThis.__CTG_TEST__ = true;
  if (!globalThis.crypto) globalThis.crypto = { randomUUID: () => "uuid" };
  return harness;
}
