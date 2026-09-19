// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Author from "./src/Author.js";
import ContactsIndex from "./src/ContactsIndex.js";
import RecipientInitial from "./src/RecipientInitial.js";

const contactsIndex = new ContactsIndex();
const renderTimers = new Map();       // tabId -> debounce timer for a render
const renderGenerations = new Map();  // tabId -> counter, drops stale renders
const watchedTabs = new Set();        // tabIds with a running change watcher
let rebuildTimer = null;              // debounce timer for the index rebuild

// Builds the avatar payload for every visible row of a mail tab and renders it.
async function cst_fun_renderTab(tabId) {
  const generation = (renderGenerations.get(tabId) || 0) + 1;
  renderGenerations.set(tabId, generation);

  try {
    const messages = await browser.headerApi.getVisibleMessages(tabId);
    const payload = [];

    for (const message of messages) {
      const author = await Author.cst_fromAuthor(message.author);
      const fallback = RecipientInitial.cst_build(author);
      const avatar = await contactsIndex.cst_getAvatar(author.cst_getEmail());

      // A newer render started while awaiting: this one is obsolete.
      if (renderGenerations.get(tabId) !== generation) {
        return;
      }

      payload.push({
        messageId: message.messageId,
        image: avatar?.value || null,
        domain: avatar?.kind === "domain",
        initials: fallback.initials,
        color: fallback.color,
        revision:
          avatar?.revision || `initial:${fallback.initials}:${fallback.color}`,
      });
    }

    if (renderGenerations.get(tabId) !== generation) {
      return;
    }
    await browser.headerApi.renderRows(tabId, JSON.stringify(payload));
  } catch (error) {
    console.warn("Could not render contact avatars for tab", tabId, error);
  }
}

// Debounces renders: many list events arrive in bursts (scroll, sort, load).
function cst_fun_scheduleTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  if (renderTimers.has(tabId)) {
    clearTimeout(renderTimers.get(tabId));
  }
  renderTimers.set(
    tabId,
    setTimeout(() => {
      renderTimers.delete(tabId);
      cst_fun_renderTab(tabId);
    }, 100),
  );
}

// Renders and watches every open mail tab.
async function cst_fun_scheduleAllTabs() {
  const tabs = await browser.tabs.query({ mailTab: true });
  for (const tab of tabs) {
    cst_fun_scheduleTab(tab.id);
    cst_fun_watchTab(tab.id);
  }
}

// Loops on waitForListChange until the tab closes, re-rendering on each change.
async function cst_fun_watchTab(tabId) {
  if (watchedTabs.has(tabId)) {
    return;
  }
  watchedTabs.add(tabId);

  try {
    while (watchedTabs.has(tabId)) {
      try {
        const eventType = await browser.headerApi.waitForListChange(tabId);
        if (eventType === "closed" || eventType === "shutdown") {
          break;
        }
        cst_fun_scheduleTab(tabId);
      } catch (_error) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        cst_fun_scheduleTab(tabId);
      }
    }
  } finally {
    watchedTabs.delete(tabId);
  }
}

// Debounces index rebuilds: an import fires one event per contact.
function cst_fun_scheduleIndexRebuild() {
  if (rebuildTimer !== null) {
    clearTimeout(rebuildTimer);
  }
  rebuildTimer = setTimeout(async () => {
    rebuildTimer = null;
    try {
      await contactsIndex.cst_build();
      await cst_fun_scheduleAllTabs();
    } catch (error) {
      console.error("Could not rebuild local contact index", error);
    }
  }, 500);
}

// Any address book change invalidates the index.
browser.contacts.onCreated.addListener(cst_fun_scheduleIndexRebuild);
browser.contacts.onUpdated.addListener(cst_fun_scheduleIndexRebuild);
browser.contacts.onDeleted.addListener(cst_fun_scheduleIndexRebuild);
browser.contacts.onManyCreated.addListener(cst_fun_scheduleIndexRebuild);
browser.addressBooks.onCreated.addListener(cst_fun_scheduleIndexRebuild);
browser.addressBooks.onDeleted.addListener(cst_fun_scheduleIndexRebuild);

browser.tabs.onActivated.addListener(({ tabId }) => {
  cst_fun_scheduleTab(tabId);
  cst_fun_watchTab(tabId);
});

browser.tabs.onRemoved.addListener((tabId) => {
  watchedTabs.delete(tabId);
  renderGenerations.delete(tabId);
  if (renderTimers.has(tabId)) {
    clearTimeout(renderTimers.get(tabId));
    renderTimers.delete(tabId);
  }
});

// Startup: build the index once, then render what is open.
try {
  await contactsIndex.cst_build();
  await cst_fun_scheduleAllTabs();
} catch (error) {
  console.error("Could not initialize local contact avatars", error);
}
