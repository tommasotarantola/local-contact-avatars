// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Message-list integration is derived from Auto Profile Picture 2.5.0 by
// Noam Schmitt and has been substantially reduced and rewritten.

// Experiment API: reads the visible rows of the message list and draws the
// bubbles into them. Runs in the privileged parent process with DOM access.

const AVATAR_OWNER = "local-contact-avatars";  // marks our own DOM nodes
const AVATAR_SELECTOR =
  `[data-local-contact-avatar-owner="${AVATAR_OWNER}"]`;
const STYLE_ID = "local-contact-avatars-style";
const SAFE_DATA_URL =
  /^data:image\/(?:jpeg|png);base64,/i;
// Events on the thread tree / table that mean "rows changed, render again".
const LIST_EVENTS = [
  "viewchange",
  "rowcountchange",
  "collapsed",
  "expanded",
  "showplaceholder",
  "scroll",
  "change",
  "drop",
  "click",
];
const TABLE_EVENTS = ["thread-changed", "sort-changed"];
const touchedWindows = new Set();  // windows to clean on shutdown
const activeWatchers = new Map();  // tabId -> finish() of the pending watcher

// The 3-pane content window (about:3pane) behind a mail tab, if any.
function cst_fun_getContentWindow(nativeTab) {
  const candidates = [
    nativeTab?.chromeBrowser?.contentWindow,
    nativeTab,
    nativeTab?.browser?.contentWindow,
    nativeTab?.messageBrowser?.contentWindow,
  ];

  for (const candidate of candidates) {
    if (candidate?.threadTree) {
      return candidate;
    }
  }

  return candidates.find(Boolean) || null;
}

// Resolves a tabId to its message-list window or throws.
function cst_fun_getWindow(context, tabId) {
  const { nativeTab } = context.extension.tabManager.get(tabId);
  const window = cst_fun_getContentWindow(nativeTab);
  if (!window?.threadTree) {
    throw new Error("No Thunderbird message-list window found");
  }
  touchedWindows.add(window);
  return window;
}

// Rendered rows as [viewIndex, rowElement], sorted by view index.
function cst_fun_getRows(window) {
  const rows = Array.from(window.threadTree?._rows || []);
  return rows.sort((left, right) => left[0] - right[0]);
}

// Skips grouped-by-sort dummy rows and IMAP-deleted rows.
function cst_fun_isMessageRow(row) {
  const properties = row?.getAttribute("data-properties") || "";
  return !properties.includes("dummy") && !properties.includes("imapdeleted");
}

function cst_fun_getMessageHeader(window, viewIndex) {
  try {
    return window.gDBView.getMsgHdrAt(viewIndex);
  } catch (_error) {
    return null;
  }
}

// Stable key of a message: folder URI + key, or the dummy URL for .eml files.
function cst_fun_getHeaderIdentity(messageHeader) {
  if (!messageHeader) {
    return null;
  }
  if (messageHeader.folder) {
    return `${messageHeader.folder.URI}\u0000${messageHeader.messageKey}`;
  }
  const dummyUrl = messageHeader.getStringProperty?.("dummyMsgUrl") || "";
  return dummyUrl ? `external\u0000${dummyUrl}` : null;
}

function cst_fun_removeAvatar(row) {
  const avatars = row?.querySelectorAll(AVATAR_SELECTOR) || [];
  for (const avatar of avatars) {
    avatar.remove();
  }
}

// Card view: append to the first card column. Table view: prepend to the
// correspondent cell (absolutely positioned there, see the CSS below).
function cst_fun_mountAvatar(row, avatar) {
  const cardColumn = row.querySelector(
    ".card-container > .thread-card-column:first-child",
  );
  if (cardColumn) {
    cardColumn.appendChild(avatar);
    return true;
  }

  const correspondentColumn = row.querySelector(".correspondentcol-column");
  if (correspondentColumn) {
    correspondentColumn.insertBefore(avatar, correspondentColumn.firstChild);
    return true;
  }

  return false;
}

// Fallback bubble: initials on the payload color, always a circle.
function cst_fun_renderInitials(document, avatar, payload) {
  avatar.replaceChildren();
  avatar.classList.remove("has-avatar");
  avatar.classList.remove("domain-avatar");
  avatar.classList.add("no-avatar");
  avatar.style.background = payload.color || "";

  const initials = document.createElement("span");
  initials.classList.add("local-contact-avatar-initials");
  initials.textContent = payload.initials || "?";
  avatar.appendChild(initials);
}

// Creates or updates the bubble of one row; unchanged revisions are skipped.
function cst_fun_renderRow(document, row, payload) {
  let avatar = row.querySelector(AVATAR_SELECTOR);
  if (avatar?.dataset.localContactAvatarRevision === payload.revision) {
    return;
  }

  if (!avatar) {
    avatar = document.createElement("div");
    avatar.classList.add("local-contact-avatar");
    avatar.dataset.localContactAvatarOwner = AVATAR_OWNER;
    if (!cst_fun_mountAvatar(row, avatar)) {
      return;
    }
  }

  avatar.dataset.localContactAvatarRevision = payload.revision || "";

  if (!payload.image || !SAFE_DATA_URL.test(payload.image)) {
    cst_fun_renderInitials(document, avatar, payload);
    return;
  }

  avatar.replaceChildren();
  avatar.classList.add("has-avatar");
  avatar.classList.remove("no-avatar");
  avatar.classList.toggle("domain-avatar", payload.domain === true);  // rounded square
  avatar.style.background = "";

  const image = document.createElement("img");
  image.classList.add("local-contact-avatar-image");
  image.alt = "Contact photo";
  // A photo that fails to decode falls back to initials.
  image.addEventListener(
    "error",
    () => {
      if (avatar.dataset.localContactAvatarRevision === payload.revision) {
        cst_fun_renderInitials(document, avatar, payload);
      }
    },
    { once: true },
  );
  image.src = payload.image;
  avatar.appendChild(image);
}

// Injects the stylesheet once per window.
function cst_fun_installCss(window) {
  const { document } = window;
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Bubble size: 32 px in card view, overridden below for table view. */
    :root {
      --local-contact-avatar-size: 32px;
    }
    /* The bubble. text-indent: 0 cancels the 18 px Thunderbird sets on the
       correspondent cell, which the initials would otherwise inherit. */
    .local-contact-avatar {
      align-items: center;
      border-radius: 50%;
      box-sizing: border-box;
      color: light-dark(#52525b, #e4e4e7);
      display: inline-flex;
      overflow: hidden;
      flex: 0 0 var(--local-contact-avatar-size);
      height: var(--local-contact-avatar-size);
      justify-content: center;
      margin-inline-end: 1px;
      text-align: center;
      text-indent: 0;
      vertical-align: middle;
      width: var(--local-contact-avatar-size);
    }
    /* Person contact: circle. */
    .local-contact-avatar-image {
      border-radius: 50%;
      height: 100%;
      object-fit: cover;
      width: 100%;
    }
    /* Domain Contact: rounded square with a black line and a white gap. */
    .local-contact-avatar.domain-avatar,
    .local-contact-avatar.domain-avatar .local-contact-avatar-image {
      border-radius: 25%;
    }
    .local-contact-avatar.domain-avatar {
      background: #ffffff;
      border: 1.5px solid #000000;
      padding: 1px;
    }
    /* Table view bubbles are 15 px: no room for the lines, shape only. */
    .table-layout .local-contact-avatar.domain-avatar {
      border: none;
      padding: 0;
    }
    .local-contact-avatar-initials {
      font-size: 0.8em;
      font-weight: 600;
      line-height: 1;
      margin: 0;
      padding: 0;
    }
    /* Table view: 15 px rows in compact/default density, 20 px in relaxed. */
    .table-layout {
      --local-contact-avatar-size: 15px;
    }
    .table-layout[style="height: 30px;"] {
      --local-contact-avatar-size: 20px;
    }
    /* Card view: the bubble replaces the native read/new symbol. */
    .card-layout .thread-card-column:first-child:has(> .local-contact-avatar) {
      justify-content: center;
    }
    .card-layout .thread-card-column:first-child
      > .local-contact-avatar {
      margin-inline: 5px 4px;
    }
    .card-layout .thread-card-column:first-child:has(> .local-contact-avatar)
      > .read-status {
      display: none;
    }
    /* Table view: absolute inside the cell (td is position: relative). */
    .correspondentcol-column .local-contact-avatar {
      left: 4.5px;
      position: absolute;
      top: calc(50% - var(--local-contact-avatar-size) / 2);
    }
  `;
  document.head.appendChild(style);
}

// Removes every bubble and the stylesheet from a window.
function cst_fun_clearWindow(window) {
  const { document } = window;
  for (const avatar of document.querySelectorAll(AVATAR_SELECTOR)) {
    avatar.remove();
  }
  document.getElementById(STYLE_ID)?.remove();
}

// Our own DOM edits must not retrigger a render.
function cst_fun_isOwnMutation(mutation) {
  if (mutation.target?.closest?.(AVATAR_SELECTOR)) {
    return true;
  }
  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return (
    changedNodes.length > 0 &&
    changedNodes.every(
      (node) =>
        node.nodeType === 1 &&
        (node.matches?.(AVATAR_SELECTOR) || node.closest?.(AVATAR_SELECTOR)),
    )
  );
}

// Resolves once with the event type at the first list change (or on unload).
function cst_fun_waitForChange(window, tabId) {
  if (activeWatchers.has(tabId)) {
    activeWatchers.get(tabId)("replaced");
  }

  return new Promise((resolve) => {
    const threadTree = window.threadTree;
    const table = threadTree.querySelector("table");
    let finished = false;
    let readinessTimer = null;

    const cleanup = () => {
      for (const eventName of LIST_EVENTS) {
        threadTree.removeEventListener(eventName, handleEvent);
      }
      if (table) {
        for (const eventName of TABLE_EVENTS) {
          table.removeEventListener(eventName, handleEvent);
        }
      }
      window.removeEventListener("unload", handleUnload);
      if (readinessTimer !== null) {
        window.clearInterval(readinessTimer);
      }
      observer.disconnect();
      if (activeWatchers.get(tabId) === finish) {
        activeWatchers.delete(tabId);
      }
    };

    const finish = (eventType) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve(eventType);
    };

    const handleEvent = (event) => finish(event.type);
    const handleUnload = () => finish("closed");
    const observer = new window.MutationObserver((mutations) => {
      if (mutations.some((mutation) => !cst_fun_isOwnMutation(mutation))) {
        finish("mutation");
      }
    });

    for (const eventName of LIST_EVENTS) {
      threadTree.addEventListener(eventName, handleEvent, { once: true });
    }
    if (table) {
      for (const eventName of TABLE_EVENTS) {
        table.addEventListener(eventName, handleEvent, { once: true });
      }
    }
    window.addEventListener("unload", handleUnload, { once: true });
    observer.observe(threadTree, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    if (!window.gDBView) {
      readinessTimer = window.setInterval(() => {
        if (window.gDBView) {
          finish("ready");
        }
      }, 250);
    }
    activeWatchers.set(tabId, finish);
  });
}

// The variable name must match the namespace in headerApi.json.
var headerApi = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      headerApi: {
        // [{ messageId, author }] for the rendered rows of a mail tab.
        async getVisibleMessages(tabId) {
          const window = cst_fun_getWindow(context, tabId);
          if (!window.gDBView) {
            return [];
          }
          const messages = [];
          const seenMessageIds = new Set();

          for (const [viewIndex, row] of cst_fun_getRows(window)) {
            if (!cst_fun_isMessageRow(row)) {
              continue;
            }
            const messageHeader = cst_fun_getMessageHeader(window, viewIndex);
            if (!messageHeader) {
              continue;
            }

            const converted = context.extension.messageManager.convert(
              messageHeader,
              { skipFolder: true },
            );
            if (!converted || seenMessageIds.has(converted.id)) {
              continue;
            }
            seenMessageIds.add(converted.id);

            messages.push({
              messageId: converted.id,
              author: converted.author || "",
            });
          }

          return messages;
        },

        // Draws the payload built by background.js into the rendered rows.
        async renderRows(tabId, payloadJSON) {
          const window = cst_fun_getWindow(context, tabId);
          if (!window.gDBView) {
            return false;
          }
          const payload = JSON.parse(payloadJSON);
          const payloadByIdentity = new Map();

          for (const item of payload) {
            const messageHeader = context.extension.messageManager.get(
              item.messageId,
            );
            const identity = cst_fun_getHeaderIdentity(messageHeader);
            if (identity) {
              payloadByIdentity.set(identity, item);
            }
          }

          cst_fun_installCss(window);
          for (const [viewIndex, row] of cst_fun_getRows(window)) {
            if (!cst_fun_isMessageRow(row)) {
              cst_fun_removeAvatar(row);
              continue;
            }

            const currentHeader = cst_fun_getMessageHeader(window, viewIndex);
            const identity = cst_fun_getHeaderIdentity(currentHeader);
            const item = identity ? payloadByIdentity.get(identity) : null;
            if (!item) {
              cst_fun_removeAvatar(row);
              continue;
            }
            cst_fun_renderRow(window.document, row, item);
          }

          return true;
        },

        // Blocks until the list changes; background.js loops on it.
        async waitForListChange(tabId) {
          const window = cst_fun_getWindow(context, tabId);
          return await cst_fun_waitForChange(window, tabId);
        },
      },
    };
  }

  // Add-on disabled/uninstalled: release watchers and undo every DOM change.
  onShutdown(_isAppShutdown) {
    for (const watcher of activeWatchers.values()) {
      watcher("shutdown");
    }
    activeWatchers.clear();

    for (const window of touchedWindows) {
      try {
        cst_fun_clearWindow(window);
      } catch (_error) {
        // Windows which have already closed no longer expose a usable document.
      }
    }
    touchedWindows.clear();
  }
};
