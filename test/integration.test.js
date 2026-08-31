import { test } from "node:test";
import assert from "node:assert/strict";

import { installFakeBrowser } from "./fake-browser.js";

let loadCounter = 0;

/** Fresh fake browser + fresh background.js module instance per call. */
async function loadBackground(init) {
  const harness = installFakeBrowser(init);
  const bg = await import(
    new URL(`../background.js?${++loadCounter}`, import.meta.url)
  );
  await bg.ready;
  return { ...harness, bg };
}

const WORK = { cookieStoreId: "c-work", name: "Work", color: "blue" };
const SHOP = { cookieStoreId: "c-shop", name: "Shopping", color: "red" };

test("new container tab creates a group named after its container", async () => {
  const h = await loadBackground({ containers: [WORK] });
  const t = h.addTab({ windowId: 1, cookieStoreId: "c-work" });

  await h.bg.placeTab(t.id);

  const groups = h.snapshotGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Work");
  assert.equal(groups[0].color, "blue");
  assert.equal(h.snapshotTabs().find((x) => x.id === t.id).g, groups[0].id);
});

test("a second tab in the same container reuses the group", async () => {
  const h = await loadBackground({ containers: [WORK] });
  const a = h.addTab({ windowId: 1, cookieStoreId: "c-work" });
  const b = h.addTab({ windowId: 1, cookieStoreId: "c-work" });

  await h.bg.placeTab(a.id);
  await h.bg.placeTab(b.id);

  assert.equal(h.snapshotGroups().length, 1);
  const tabs = h.snapshotTabs();
  assert.equal(tabs.find((x) => x.id === a.id).g, tabs.find((x) => x.id === b.id).g);
});

test("reconcile consolidates a stray tab into the container's existing window", async () => {
  const h = await loadBackground({ containers: [WORK] });
  // window 1: a Work group; window 2: an unrelated tab + a stray Work tab
  const w1 = h.addTab({ windowId: 1, cookieStoreId: "c-work" });
  await h.bg.placeTab(w1.id);
  h.addTab({ windowId: 2, cookieStoreId: "firefox-default" });
  const stray = h.addTab({ windowId: 2, cookieStoreId: "c-work" });

  await h.bg.reconcileAll();

  const s = h.snapshotTabs().find((x) => x.id === stray.id);
  assert.equal(s.w, 1, "stray tab moved to window 1");
  assert.equal(h.snapshotGroups().length, 1);
  assert.equal(s.g, h.snapshotGroups()[0].id);
});

test("reconcile merges two same-named groups across windows into the oldest", async () => {
  const h = await loadBackground({ containers: [WORK] });
  const a = h.addTab({ windowId: 1, cookieStoreId: "c-work" });
  h.addTab({ windowId: 1, cookieStoreId: "firefox-default" });
  await h.bg.placeTab(a.id); // group #1 in window 1

  // Independently make a second "Work" group in window 2.
  const b = h.addTab({ windowId: 2, cookieStoreId: "c-work" });
  h.addTab({ windowId: 2, cookieStoreId: "firefox-default" });
  const g2 = await h.browser.tabs.group({
    tabIds: [b.id],
    createProperties: { windowId: 2 },
  });
  await h.browser.tabGroups.update(g2, { title: "Work" });
  assert.equal(h.snapshotGroups().length, 2);

  await h.bg.reconcileAll();

  const groups = h.snapshotGroups();
  assert.equal(groups.length, 1, "duplicate group drained and dropped");
  assert.equal(groups[0].title, "Work");
  for (const id of [a.id, b.id]) {
    assert.equal(h.snapshotTabs().find((x) => x.id === id).g, groups[0].id);
  }
});

test("newTabPosition: leftmost vs rightmost placement in the group", async () => {
  for (const [pos, expectFirst] of [
    ["rightmost", false],
    ["leftmost", true],
  ]) {
    const h = await loadBackground({
      containers: [WORK],
      storageLocal: { settings: { newTabPosition: pos } },
    });
    const a = h.addTab({ windowId: 1, cookieStoreId: "c-work" });
    const b = h.addTab({ windowId: 1, cookieStoreId: "c-work" });
    await h.bg.placeTab(a.id);
    await h.bg.placeTab(b.id);
    // newcomer arrives: an ungrouped Work tab created "in the middle"
    const c = h.addTab({ windowId: 1, cookieStoreId: "c-work" });
    await h.bg.placeTab(c.id);

    const groupId = h.snapshotGroups()[0].id;
    const inGroup = h
      .snapshotTabs()
      .filter((x) => x.g === groupId)
      .sort((x, y) => x.i - y.i)
      .map((x) => x.id);
    if (expectFirst) {
      assert.equal(inGroup[0], c.id, `${pos}: newcomer is first`);
    } else {
      assert.equal(inGroup[inGroup.length - 1], c.id, `${pos}: newcomer is last`);
    }
  }
});

test("site routing reopens a matching tab in the target container", async () => {
  const h = await loadBackground({
    containers: [WORK],
    storageLocal: {
      containerRules: [
        {
          id: "r1",
          pattern: "example.com",
          matchType: "domain",
          cookieStoreId: "c-work",
          enabled: true,
        },
      ],
    },
  });
  const t = h.addTab({
    windowId: 1,
    cookieStoreId: "firefox-default",
    url: "about:blank",
  });

  const res = await h.bg.handleRequest({
    tabId: t.id,
    frameId: 0,
    url: "https://www.example.com/page",
  });

  assert.deepEqual(res, { cancel: true });
  const tabs = h.state.tabs;
  assert.equal(tabs.length, 1, "old tab replaced");
  assert.equal(tabs[0].cookieStoreId, "c-work");
  assert.equal(tabs[0].url, "https://www.example.com/page");

  // loop guard: the freshly-created tab must not be reopened again
  const again = await h.bg.handleRequest({
    tabId: tabs[0].id,
    frameId: 0,
    url: "https://www.example.com/page",
  });
  assert.deepEqual(again, {});
});

test("site routing leaves a tab already in the right container alone", async () => {
  const h = await loadBackground({
    containers: [WORK],
    storageLocal: {
      containerRules: [
        { id: "r1", pattern: "example.com", matchType: "domain", cookieStoreId: "c-work", enabled: true },
      ],
    },
  });
  const t = h.addTab({ windowId: 1, cookieStoreId: "c-work", url: "about:blank" });
  const res = await h.bg.handleRequest({
    tabId: t.id,
    frameId: 0,
    url: "https://example.com/",
  });
  assert.deepEqual(res, {});
  assert.equal(h.state.tabs.length, 1);
});

test("new-tab inheritance: blank tab adopts the active tab's container", async () => {
  const h = await loadBackground({
    containers: [WORK],
    storageLocal: { settings: { newTabInheritsContainer: true } },
  });
  const current = h.addTab({ windowId: 1, cookieStoreId: "c-work", active: true });
  await h.bg.trackActive(1, current.id);

  const blank = h.addTab({
    windowId: 1,
    cookieStoreId: "firefox-default",
    url: "about:newtab",
    active: true,
  });
  await h.bg.maybeInheritContainer(blank, "c-work");

  const stores = h.state.tabs.map((t) => t.cookieStoreId).sort();
  assert.deepEqual(stores, ["c-work", "c-work"]);
  assert.ok(!h.state.tabs.some((t) => t.id === blank.id), "blank tab replaced");
});

test("new-tab inheritance: a link-opened tab (has opener) is left alone", async () => {
  const h = await loadBackground({
    containers: [WORK],
    storageLocal: { settings: { newTabInheritsContainer: true } },
  });
  const blank = h.addTab({
    windowId: 1,
    cookieStoreId: "firefox-default",
    url: "about:blank",
    openerTabId: 42,
  });
  await h.bg.maybeInheritContainer(blank, "c-work");
  assert.equal(h.state.tabs.length, 1);
  assert.equal(h.state.tabs[0].cookieStoreId, "firefox-default");
});

test("container rename propagates to the existing group", async () => {
  const h = await loadBackground({ containers: [WORK] });
  const t = h.addTab({ windowId: 1, cookieStoreId: "c-work" });
  await h.bg.placeTab(t.id);
  assert.equal(h.snapshotGroups()[0].title, "Work");

  h.setContainer({ cookieStoreId: "c-work", name: "Job", color: "green" });
  await h.bg.syncAllGroupMeta();

  const g = h.snapshotGroups()[0];
  assert.equal(g.title, "Job");
  assert.equal(g.color, "green");
});

test("last window is never emptied by consolidation", async () => {
  const h = await loadBackground({ containers: [WORK] });
  // Only one window, one tab.
  const only = h.addTab({ windowId: 1, cookieStoreId: "c-work" });
  await h.bg.reconcileAll();
  assert.equal(h.snapshotTabs().find((x) => x.id === only.id).w, 1);
  assert.equal(h.state.tabs.length, 1);
});

test("two containers get two independent groups", async () => {
  const h = await loadBackground({ containers: [WORK, SHOP] });
  const a = h.addTab({ windowId: 1, cookieStoreId: "c-work" });
  const b = h.addTab({ windowId: 1, cookieStoreId: "c-shop" });
  await h.bg.placeTab(a.id);
  await h.bg.placeTab(b.id);

  const groups = h.snapshotGroups();
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.title).sort(), ["Shopping", "Work"]);
});
