const DEFAULT_SETTINGS = {
  enabled: true,
  trailColor: "#2563eb",
  gestures: {
    back: "L",
    forward: "R",
    top: "RU",
    bottom: "RD",
    scrollDown: "D",
    scrollUp: "U",
    refresh: "UD",
    close: "DR",
    reopen: "DL"
  }
};
const LEGACY_DEFAULT_GESTURES = {
  back: "L",
  forward: "R",
  top: "U",
  bottom: "D",
  scrollDown: "RD",
  scrollUp: "RU",
  refresh: "UR",
  close: "DR",
  reopen: "DL"
};
const ACTION_KEYS = Object.keys(DEFAULT_SETTINGS.gestures);
const GESTURE_PATTERN = /^[LRUD]{1,4}$/;
const DISALLOWED_GESTURES = new Set(["LD"]);
const CLOSED_TABS_KEY = "closedTabs";
const MAX_CLOSED_TABS = 10;

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const storedGestures = {
    ...DEFAULT_SETTINGS.gestures,
    ...(stored.gestures || {})
  };
  const shouldMigrateLegacyDefaults = isSameGestureMap(storedGestures, LEGACY_DEFAULT_GESTURES);
  const gestures = normalizeGestures(
    shouldMigrateLegacyDefaults ? DEFAULT_SETTINGS.gestures : storedGestures
  );

  if (shouldMigrateLegacyDefaults) {
    await chrome.storage.local.set({ gestures });
  }

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    gestures
  };
}

function isSameGestureMap(first, second) {
  return ACTION_KEYS.every((action) => first[action] === second[action]);
}

function normalizeGestures(gestures) {
  const result = {};
  const used = new Set();

  for (const action of ACTION_KEYS) {
    const candidate = String(gestures?.[action] || "").toUpperCase();
    if (GESTURE_PATTERN.test(candidate) && !DISALLOWED_GESTURES.has(candidate) && !used.has(candidate)) {
      result[action] = candidate;
      used.add(candidate);
      continue;
    }

    const fallback = DEFAULT_SETTINGS.gestures[action];
    if (!used.has(fallback)) {
      result[action] = fallback;
      used.add(fallback);
    }
  }

  return result;
}

function getRecentlyClosedSessions() {
  return new Promise((resolve, reject) => {
    chrome.sessions.getRecentlyClosed({ maxResults: 1 }, (sessions) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(sessions || []);
    });
  });
}

function restoreClosedSession(sessionId) {
  return new Promise((resolve, reject) => {
    chrome.sessions.restoreRecentlyClosed(sessionId, (session) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(session);
    });
  });
}

async function rememberClosedTab(tab) {
  const url = tab.url || tab.pendingUrl;
  if (!url || !/^(https?|file|ftp):/i.test(url)) return;

  const stored = await chrome.storage.local.get({ [CLOSED_TABS_KEY]: [] });
  const closedTabs = stored[CLOSED_TABS_KEY] || [];
  const next = [
    {
      url,
      title: tab.title || "",
      pinned: Boolean(tab.pinned)
    },
    ...closedTabs.filter((item) => item.url !== url)
  ].slice(0, MAX_CLOSED_TABS);
  await chrome.storage.local.set({ [CLOSED_TABS_KEY]: next });
}

async function takeFallbackClosedTab() {
  const stored = await chrome.storage.local.get({ [CLOSED_TABS_KEY]: [] });
  const closedTabs = stored[CLOSED_TABS_KEY] || [];
  const [latest, ...remaining] = closedTabs;
  if (!latest) return null;
  await chrome.storage.local.set({ [CLOSED_TABS_KEY]: remaining });
  return latest;
}

async function forgetFallbackByUrl(url) {
  if (!url) return;
  const stored = await chrome.storage.local.get({ [CLOSED_TABS_KEY]: [] });
  const remaining = (stored[CLOSED_TABS_KEY] || []).filter((item) => item.url !== url);
  await chrome.storage.local.set({ [CLOSED_TABS_KEY]: remaining });
}

function getSessionUrl(session) {
  if (session?.tab?.url) return session.tab.url;
  return session?.window?.tabs?.[0]?.url || "";
}

async function runTabAction(action, tabId) {
  switch (action) {
    case "back":
      await chrome.tabs.goBack(tabId);
      break;
    case "forward":
      await chrome.tabs.goForward(tabId);
      break;
    case "refresh":
      await chrome.tabs.reload(tabId);
      break;
    case "close": {
      const tab = await chrome.tabs.get(tabId);
      await rememberClosedTab(tab);
      await chrome.tabs.remove(tabId);
      break;
    }
    case "reopen": {
      let sessionError = null;
      try {
        const sessions = await getRecentlyClosedSessions();
        const latest = sessions[0];
        if (latest?.sessionId) {
          const restored = await restoreClosedSession(latest.sessionId);
          await forgetFallbackByUrl(getSessionUrl(restored));
          break;
        }
      } catch (error) {
        sessionError = error;
      }

      const fallback = await takeFallbackClosedTab();
      if (!fallback) {
        throw sessionError || new Error("没有可重新打开的关闭标签");
      }
      await chrome.tabs.create({
        url: fallback.url,
        active: true,
        pinned: fallback.pinned
      });
      break;
    }
    default:
      throw new Error(`Unknown tab action: ${action}`);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  if (!existing || typeof existing.enabled !== "boolean") {
    await chrome.storage.local.set(DEFAULT_SETTINGS);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "GET_SETTINGS") {
      sendResponse({ ok: true, settings: await getSettings() });
      return;
    }

    if (message.type === "SET_SETTINGS") {
      const current = await getSettings();
      const settings = {
        ...current,
        ...message.settings,
        gestures: normalizeGestures({
          ...current.gestures,
          ...(message.settings?.gestures || {})
        })
      };
      await chrome.storage.local.set(settings);
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs
        .filter((tab) => typeof tab.id === "number")
        .map((tab) => chrome.tabs.sendMessage(tab.id, {
          type: "SETTINGS_UPDATED",
          settings
        }).catch(() => undefined)));
      sendResponse({ ok: true, settings });
      return;
    }

    if (message.type === "TAB_ACTION") {
      const tabId = sender.tab?.id ?? message.tabId;
      if (typeof tabId !== "number") {
        throw new Error("No active tab was found");
      }
      await runTabAction(message.action, tabId);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "OPEN_LINK") {
      if (typeof message.url !== "string" || !/^(https?:|file:|ftp:)/i.test(message.url)) {
        throw new Error("不支持打开此链接");
      }
      const createProperties = { url: message.url, active: true };
      if (typeof sender.tab?.index === "number") {
        createProperties.index = sender.tab.index + 1;
      }
      await chrome.tabs.create(createProperties);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type" });
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});
