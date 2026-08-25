const DEFAULT_SETTINGS = {
  enabled: true,
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

const ACTIONS = [
  ["back", "后退"],
    ["forward", "前进"],
    ["top", "滚动到顶端"],
    ["bottom", "滚动到底端"],
    ["scrollDown", "下滑"],
    ["scrollUp", "上滑"],
    ["refresh", "刷新"],
  ["close", "关闭当前标签"],
  ["reopen", "打开最近关闭的标签"]
];

const GESTURE_OPTIONS = [
  ["L", "←"], ["R", "→"], ["U", "↑"], ["D", "↓"],
  ["LU", "←↑"], ["UR", "↑→"], ["RD", "→↓"], ["DL", "↓←"],
  ["UL", "↑←"], ["RU", "→↑"], ["DR", "↓→"],
  ["LR", "←→"], ["RL", "→←"], ["UD", "↑↓"], ["DU", "↓↑"]
];

const enabledInput = document.querySelector("#enabled");
const settingsContainer = document.querySelector("#gesture-settings");
const saveButton = document.querySelector("#save");
const resetButton = document.querySelector("#reset");
const status = document.querySelector("#status");
let currentSettings = structuredClone(DEFAULT_SETTINGS);

function setStatus(message) {
  status.textContent = message;
  window.setTimeout(() => {
    status.textContent = "";
  }, 1500);
}

function renderGestureSettings(gestures) {
  settingsContainer.replaceChildren();

  for (const [action, label] of ACTIONS) {
    const row = document.createElement("label");
    row.className = "gesture-row";
    row.htmlFor = `gesture-${action}`;

    const name = document.createElement("span");
    name.textContent = label;

    const select = document.createElement("select");
    select.id = `gesture-${action}`;
    select.dataset.action = action;
    select.title = `${label}的手势`;

    for (const [value, display] of GESTURE_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${display}  (${value})`;
      option.selected = gestures[action] === value;
      select.appendChild(option);
    }

    row.append(name, select);
    settingsContainer.appendChild(row);
  }
}

function readGestures() {
  const gestures = {};
  for (const select of settingsContainer.querySelectorAll("select")) {
    gestures[select.dataset.action] = select.value;
  }
  return gestures;
}

function hasDuplicateGestures(gestures) {
  const values = Object.values(gestures);
  return new Set(values).size !== values.length;
}

function sendSettings(settings, successMessage) {
  chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      setStatus(response?.error || "保存设置失败");
      return;
    }
    currentSettings = response.settings;
    enabledInput.checked = currentSettings.enabled;
    renderGestureSettings(currentSettings.gestures);
    setStatus(successMessage);
  });
}

chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
  if (chrome.runtime.lastError || !response?.ok) {
    renderGestureSettings(currentSettings.gestures);
    setStatus("读取设置失败");
    return;
  }
  currentSettings = response.settings;
  enabledInput.checked = currentSettings.enabled;
  renderGestureSettings(currentSettings.gestures);
});

enabledInput.addEventListener("change", () => {
  sendSettings({ enabled: enabledInput.checked }, enabledInput.checked ? "手势已启用" : "手势已停用");
});

saveButton.addEventListener("click", () => {
  const gestures = readGestures();
  if (hasDuplicateGestures(gestures)) {
    setStatus("每个功能必须使用不同的手势");
    return;
  }
  sendSettings({ gestures }, "手势设置已保存");
});

resetButton.addEventListener("click", () => {
  renderGestureSettings(DEFAULT_SETTINGS.gestures);
  sendSettings({ gestures: DEFAULT_SETTINGS.gestures }, "已恢复默认手势");
});
