import { DEFAULT_SETTINGS, DEFAULT_STORE } from "./core.js";

const CHECKBOX_FIELDS = [
  "groupDefaultContainer",
  "syncTitleAndColor",
  "newTabInheritsContainer",
];

const MATCH_LABELS = {
  domain: "Domain + subdomains",
  exact: "Exact host",
  glob: "URL glob",
};

let containers = []; // { cookieStoreId, name }
let rules = [];

/* ------------------------------- settings ------------------------------- */

async function restoreSettings() {
  const stored = await browser.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  for (const id of CHECKBOX_FIELDS) {
    document.getElementById(id).checked = Boolean(s[id]);
  }
  const pos = s.newTabPosition === "leftmost" ? "leftmost" : "rightmost";
  const radio = document.querySelector(
    `input[name="newTabPosition"][value="${pos}"]`
  );
  if (radio) radio.checked = true;
}

async function saveSettings() {
  const s = {};
  for (const id of CHECKBOX_FIELDS) {
    s[id] = document.getElementById(id).checked;
  }
  const picked = document.querySelector(
    'input[name="newTabPosition"]:checked'
  );
  s.newTabPosition = picked && picked.value === "leftmost" ? "leftmost" : "rightmost";
  await browser.storage.local.set({ settings: s });
}

/* -------------------------------- rules -------------------------------- */

async function loadContainers() {
  const list = await browser.contextualIdentities.query({});
  containers = [
    { cookieStoreId: DEFAULT_STORE, name: "No container" },
    ...list.map((c) => ({ cookieStoreId: c.cookieStoreId, name: c.name })),
  ];
}

function containerName(cookieStoreId) {
  const c = containers.find((x) => x.cookieStoreId === cookieStoreId);
  return c ? c.name : "(removed container)";
}

function fillContainerSelect(select, selected) {
  select.textContent = "";
  for (const c of containers) {
    const opt = document.createElement("option");
    opt.value = c.cookieStoreId;
    opt.textContent = c.name;
    if (c.cookieStoreId === selected) opt.selected = true;
    select.append(opt);
  }
}

async function loadRules() {
  const stored = await browser.storage.local.get("containerRules");
  rules = Array.isArray(stored.containerRules) ? stored.containerRules : [];
}

async function saveRules() {
  await browser.storage.local.set({ containerRules: rules });
}

function renderRules() {
  const tbody = document.getElementById("rules");
  tbody.textContent = "";

  if (rules.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "empty";
    td.textContent = "No rules yet.";
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const rule of rules) {
    const tr = document.createElement("tr");

    const pattern = document.createElement("td");
    pattern.className = "pattern";
    pattern.textContent = rule.pattern;

    const match = document.createElement("td");
    match.textContent = MATCH_LABELS[rule.matchType] || rule.matchType;

    const container = document.createElement("td");
    const select = document.createElement("select");
    fillContainerSelect(select, rule.cookieStoreId);
    select.addEventListener("change", async () => {
      rule.cookieStoreId = select.value;
      await saveRules();
    });
    container.append(select);

    const enabled = document.createElement("td");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = rule.enabled !== false;
    toggle.addEventListener("change", async () => {
      rule.enabled = toggle.checked;
      await saveRules();
    });
    enabled.append(toggle);

    const remove = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "remove";
    btn.type = "button";
    btn.title = "Remove rule";
    btn.textContent = "×";
    btn.addEventListener("click", async () => {
      rules = rules.filter((r) => r.id !== rule.id);
      await saveRules();
      renderRules();
    });
    remove.append(btn);

    tr.append(pattern, match, container, enabled, remove);
    tbody.append(tr);
  }
}

async function addRule() {
  const patternEl = document.getElementById("newPattern");
  const pattern = patternEl.value.trim();
  if (!pattern) {
    patternEl.focus();
    return;
  }
  rules.push({
    id: crypto.randomUUID(),
    pattern,
    matchType: document.getElementById("newMatchType").value,
    cookieStoreId: document.getElementById("newContainer").value,
    enabled: true,
  });
  await saveRules();
  patternEl.value = "";
  renderRules();
}

/* --------------------------------- init -------------------------------- */

async function init() {
  await Promise.all([restoreSettings(), loadContainers(), loadRules()]);

  for (const id of CHECKBOX_FIELDS) {
    document.getElementById(id).addEventListener("change", saveSettings);
  }
  for (const radio of document.querySelectorAll(
    'input[name="newTabPosition"]'
  )) {
    radio.addEventListener("change", saveSettings);
  }

  fillContainerSelect(document.getElementById("newContainer"));
  document.getElementById("addRule").addEventListener("click", addRule);
  document.getElementById("newPattern").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addRule();
  });

  renderRules();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.containerRules) {
    rules = Array.isArray(changes.containerRules.newValue)
      ? changes.containerRules.newValue
      : [];
    renderRules();
  }
});

browser.contextualIdentities.onCreated.addListener(refreshContainers);
browser.contextualIdentities.onRemoved.addListener(refreshContainers);
browser.contextualIdentities.onUpdated.addListener(refreshContainers);

async function refreshContainers() {
  await loadContainers();
  fillContainerSelect(document.getElementById("newContainer"));
  renderRules();
}

document.addEventListener("DOMContentLoaded", init);
