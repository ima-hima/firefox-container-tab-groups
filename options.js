"use strict";

const DEFAULTS = {
  groupDefaultContainer: false,
  syncTitleAndColor: true,
};

const FIELDS = Object.keys(DEFAULTS);

async function restore() {
  const stored = await browser.storage.local.get("settings");
  const settings = { ...DEFAULTS, ...(stored.settings || {}) };
  for (const id of FIELDS) {
    document.getElementById(id).checked = Boolean(settings[id]);
  }
}

async function save() {
  const settings = {};
  for (const id of FIELDS) {
    settings[id] = document.getElementById(id).checked;
  }
  await browser.storage.local.set({ settings });
}

document.addEventListener("DOMContentLoaded", restore);
for (const id of FIELDS) {
  document.getElementById(id).addEventListener("change", save);
}
