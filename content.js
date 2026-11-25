(() => {
  "use strict";

  const START_DISTANCE = 10;
  const SAMPLE_DISTANCE = 8;
  const MAX_GESTURE_TIME = 1400;
  const DOUBLE_RIGHT_CLICK_TIME = 500;
  const isMac = navigator.platform.startsWith("Mac");
  const ACTION_LABELS = {
    top: "滚动到顶端",
    bottom: "滚动到底端",
    refresh: "刷新",
    close: "关闭当前标签",
    reopen: "打开最近关闭的标签"
  };

  let enabled = true;
  let tracking = false;
  let gestureStarted = false;
  let startedAt = 0;
  let points = [];
  let directions = [];
  let previousPoint = null;
  let overlay = null;
  let canvas = null;
  let context = null;
  let label = null;
  let previousUserSelect = null;
  let trailColor = "#2563eb";
  let gestureMap = {};
  let suppressNextContextMenu = false;
  let suppressTimer = null;
  let linkTarget = null;
  let linkDragStarted = false;
  let lastRightClick = null;

  function applySettings(settings) {
    enabled = settings.enabled;
    trailColor = settings.trailColor;
    gestureMap = {};
    for (const [action, gesture] of Object.entries(settings.gestures || {})) {
      if (gesture !== "LD" && !gestureMap[gesture] && ACTION_LABELS[action]) {
        gestureMap[gesture] = { action, label: ACTION_LABELS[action] };
      }
    }
  }

  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) return;
    applySettings(response.settings);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "SETTINGS_UPDATED") return;
    applySettings(message.settings);
  });

  function ensureOverlay() {
    if (overlay) return;

    overlay = document.createElement("div");
    overlay.id = "mouse-gesture-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "pointer-events:none",
      "display:none"
    ].join(";");

    canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    context = canvas.getContext("2d");

    label = document.createElement("div");
    label.style.cssText = [
      "position:absolute",
      "left:50%",
      "top:24px",
      "transform:translateX(-50%)",
      "padding:7px 12px",
      "border-radius:6px",
      "background:rgba(15,23,42,.9)",
      "color:#fff",
      "font:600 13px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:0 4px 14px rgba(0,0,0,.2)",
      "white-space:nowrap"
    ].join(";");

    overlay.append(canvas, label);
    (document.documentElement || document.body).appendChild(overlay);
  }

  function resizeCanvas() {
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function resetGesture() {
    tracking = false;
    gestureStarted = false;
    startedAt = 0;
    points = [];
    directions = [];
    previousPoint = null;
    if (overlay) overlay.style.display = "none";
    if (previousUserSelect !== null) {
      document.documentElement.style.userSelect = previousUserSelect;
    }
    previousUserSelect = null;
    linkTarget = null;
    linkDragStarted = false;
  }

  function armContextMenuSuppression() {
    suppressNextContextMenu = true;
    if (suppressTimer) window.clearTimeout(suppressTimer);
    suppressTimer = window.setTimeout(() => {
      suppressNextContextMenu = false;
      suppressTimer = null;
    }, 1000);
  }

  function showOverlay() {
    ensureOverlay();
    resizeCanvas();
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    label.textContent = "绘制手势";
    overlay.style.display = "block";
  }

  function getDraggedLink(target) {
    const link = target instanceof Element ? target.closest("a[href]") : null;
    if (!link) return null;

    try {
      const url = new URL(link.href, window.location.href);
      if (!["http:", "https:", "file:", "ftp:"].includes(url.protocol)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function drawTrail() {
    if (!context || points.length < 2) return;
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index].x, points[index].y);
    }
    context.strokeStyle = trailColor;
    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = "rgba(37,99,235,.3)";
    context.shadowBlur = 5;
    context.stroke();
    context.shadowBlur = 0;
  }

  function getDirection(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "R" : "L";
    return dy >= 0 ? "D" : "U";
  }

  function addDirection(point) {
    if (!previousPoint) {
      previousPoint = point;
      return;
    }

    const dx = point.x - previousPoint.x;
    const dy = point.y - previousPoint.y;
    const distance = Math.hypot(dx, dy);
    if (distance < SAMPLE_DISTANCE) return;

    const direction = getDirection(dx, dy);
    if (directions[directions.length - 1] !== direction) {
      directions.push(direction);
    }
    previousPoint = point;
  }

  function recognize() {
    const cleaned = [];
    for (const direction of directions) {
      if (cleaned[cleaned.length - 1] !== direction) cleaned.push(direction);
    }

    if (cleaned.length === 1 && points.length > 1) {
      const first = points[0];
      const last = points[points.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      const horizontal = Math.abs(dx);
      const vertical = Math.abs(dy);
      const dominantDistance = Math.max(horizontal, vertical);
      const secondaryDistance = Math.min(horizontal, vertical);
      if (dominantDistance >= START_DISTANCE && secondaryDistance >= dominantDistance * 0.55) {
        return null;
      }
    }

    if (cleaned.length === 1) return gestureMap[cleaned[0]];
    if (cleaned.length >= 2) return gestureMap[cleaned.join("")];
    return null;
  }

  function scrollTo(position) {
    const root = document.scrollingElement || document.documentElement;
    const top = position === "top" ? 0 : root.scrollHeight;
    window.scrollTo({ top, behavior: "smooth" });
  }

  function showResult(text) {
    if (!overlay) return;
    overlay.style.display = "block";
    label.textContent = text;
    window.setTimeout(() => {
      if (overlay) overlay.style.display = "none";
    }, 650);
  }

  function performAction(result) {
    if (!result) {
      showResult("未识别手势");
      return;
    }

    if (result.action === "top" || result.action === "bottom") {
      scrollTo(result.action);
      showResult(result.label);
      return;
    }

    showResult(result.label);
    chrome.runtime.sendMessage({ type: "TAB_ACTION", action: result.action }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        showResult(response?.error || "当前页面无法执行该操作");
      }
    });
  }

  function openDraggedLink(url) {
    showResult("在新标签打开链接");
    chrome.runtime.sendMessage({ type: "OPEN_LINK", url }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        showResult(response?.error || "链接打开失败");
      }
    });
  }

  function onMouseDown(event) {
    const previousClick = lastRightClick;
    lastRightClick = null;
    if (!enabled || event.button !== 2 || (isMac && event.ctrlKey)) return;
    if (tracking) resetGesture();
    if (isMac && previousClick &&
        Date.now() - previousClick.time <= DOUBLE_RIGHT_CLICK_TIME &&
        Math.hypot(event.clientX - previousClick.x, event.clientY - previousClick.y) < START_DISTANCE) {
      return;
    }
    tracking = true;
    gestureStarted = false;
    linkTarget = getDraggedLink(event.target);
    linkDragStarted = false;
    startedAt = Date.now();
    points = [{ x: event.clientX, y: event.clientY }];
    directions = [];
    previousPoint = points[0];
    suppressNextContextMenu = false;
    if (suppressTimer) {
      window.clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  }

  function onMouseMove(event) {
    if (!tracking) return;
    if (!(event.buttons & 2)) {
      resetGesture();
      return;
    }
    if (event.buttons !== 2) return;
    if (Date.now() - startedAt > MAX_GESTURE_TIME) {
      resetGesture();
      return;
    }

    const firstPoint = points[0];
    const distanceFromStart = Math.hypot(event.clientX - firstPoint.x, event.clientY - firstPoint.y);
    if (!gestureStarted && distanceFromStart < START_DISTANCE) return;

    if (linkTarget && !linkDragStarted) {
      linkDragStarted = true;
      showOverlay();
      label.textContent = "在新标签打开链接";
      previousUserSelect = document.documentElement.style.userSelect;
      document.documentElement.style.userSelect = "none";
      event.preventDefault();
    }

    if (linkDragStarted) {
      armContextMenuSuppression();
      event.preventDefault();
      return;
    }

    if (!gestureStarted) {
      gestureStarted = true;
      showOverlay();
      previousUserSelect = document.documentElement.style.userSelect;
      document.documentElement.style.userSelect = "none";
      event.preventDefault();
    }

    const point = { x: event.clientX, y: event.clientY };
    points.push(point);
    addDirection(point);
    drawTrail();

    const result = recognize();
    if (result) armContextMenuSuppression();
    label.textContent = result ? result.label : directions.join(" ");
  }

  function onMouseUp(event) {
    if (!tracking || event.button !== 2) return;
    if (isMac && !gestureStarted && !linkDragStarted &&
        Date.now() - startedAt <= DOUBLE_RIGHT_CLICK_TIME &&
        Math.hypot(event.clientX - points[0].x, event.clientY - points[0].y) < START_DISTANCE) {
      lastRightClick = { time: Date.now(), x: event.clientX, y: event.clientY };
    }
    const draggedLink = linkDragStarted ? linkTarget : null;
    if (draggedLink) {
      armContextMenuSuppression();
      resetGesture();
      event.preventDefault();
      openDraggedLink(draggedLink);
      return;
    }

    const hadGesture = gestureStarted;
    const result = recognize();
    if (result) armContextMenuSuppression();
    resetGesture();
    if (hadGesture) {
      event.preventDefault();
      performAction(result);
    }
  }

  function onContextMenu(event) {
    if (isMac && event.ctrlKey) return;
    // Chrome on macOS opens the menu before the pointer has moved.
    if (isMac && tracking && event.button === 2) {
      event.preventDefault();
      return;
    }
    if (gestureStarted || linkDragStarted || suppressNextContextMenu) {
      event.preventDefault();
      suppressNextContextMenu = false;
      if (suppressTimer) {
        window.clearTimeout(suppressTimer);
        suppressTimer = null;
      }
    }
  }

  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("blur", () => {
    lastRightClick = null;
    resetGesture();
  });
})();
