/**
 * Cloud Clipboard frontend logic.
 */

const scriptEl = document.currentScript || document.querySelector("script[data-room]");
const ROOM_ID = scriptEl?.dataset.room || "";
const API_BASE = "";
const POLL_INTERVAL = 5000;
const STREAM_RETRY_DELAY = 2000;
const MOBILE_PREVIEW_LIMIT = 56;
const DESKTOP_PREVIEW_LIMIT = 150;
const AUTO_SEND_DELAY = 1000;
const FOREGROUND_SYNC_COOLDOWN_MS = 800;
const CUSTOM_ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const compactPreviewQuery = window.matchMedia("(max-width: 560px)");

const $ = (selector) => document.querySelector(selector);

const inputSection = $("#inputSection");
const inputArea = $("#inputArea");
const btnRefresh = $("#btnRefresh");
const btnClear = $("#btnClear");
const btnNewRoom = $("#btnNewRoom");
const btnCopyUrl = $("#btnCopyUrl");
const itemList = $("#itemList");
const emptyState = $("#emptyState");
const itemCount = $("#itemCount");
const roomBadge = $("#roomBadge");
const qrContainer = $("#qrContainer");
const qrUrl = $("#qrUrl");
const clearConfirmModal = $("#clearConfirmModal");
const newRoomModal = $("#newRoomModal");
const toastContainer = $("#toastContainer");
const clearConfirmCount = $("#clearConfirmCount");
const btnCloseClearConfirm = $("#btnCloseClearConfirm");
const btnConfirmClear = $("#btnConfirmClear");
const btnCloseNewRoomModal = $("#btnCloseNewRoomModal");
const btnCreateRandomRoom = $("#btnCreateRandomRoom");
const btnCreateCustomRoom = $("#btnCreateCustomRoom");
const newRoomCustomInput = $("#newRoomCustomInput");

let isLoading = false;
let queuedLoadOptions = null;
let realtimeSource = null;
let reconnectTimer = null;
let pollTimer = null;
let activeModal = null;
let lastFocusedElement = null;
let isClearing = false;
let isSending = false;
let isComposing = false;
let autoSendTimer = null;
let pendingAutoSend = false;
let currentItems = [];
let isCompactPreview = compactPreviewQuery.matches;
let lastForegroundSyncAt = 0;

roomBadge.textContent = ROOM_ID;
roomBadge.title = `点击复制房间号：${ROOM_ID}`;
autoResize();
bindEvents();
loadQr();
loadItems({ forceFresh: true });
startRealtimeSync();

function bindEvents() {
  inputSection.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLElement)) {
      return;
    }

    if (event.target.closest("button")) {
      return;
    }

    inputArea.focus();
  });

  inputArea.addEventListener("input", () => {
    autoResize();
    if (!isComposing) {
      scheduleAutoSend();
    }
  });

  inputArea.addEventListener("compositionstart", () => {
    isComposing = true;
    clearAutoSendTimer();
  });

  inputArea.addEventListener("compositionend", () => {
    isComposing = false;
    autoResize();
    scheduleAutoSend();
  });

  inputArea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      sendItem({ successMessage: "已发送" });
    }
  });

  btnRefresh.addEventListener("click", () => loadItems({ manual: true, forceFresh: true }));
  btnClear.addEventListener("click", openClearConfirmModal);
  btnNewRoom.addEventListener("click", openNewRoomModal);
  roomBadge.addEventListener("click", () => copyText(ROOM_ID, "房间号已复制"));
  btnCopyUrl.addEventListener("click", () => copyText(window.location.href, "链接已复制"));

  btnCloseClearConfirm.addEventListener("click", () => setModalOpen(clearConfirmModal, false));
  btnConfirmClear.addEventListener("click", confirmClearItems);
  btnCloseNewRoomModal.addEventListener("click", () => setModalOpen(newRoomModal, false));
  btnCreateRandomRoom.addEventListener("click", goToRandomRoom);
  btnCreateCustomRoom.addEventListener("click", goToCustomRoom);

  newRoomCustomInput.addEventListener("input", () => {
    const normalized = normalizeRoomId(newRoomCustomInput.value);
    if (newRoomCustomInput.value !== normalized) {
      newRoomCustomInput.value = normalized;
    }
  });

  newRoomCustomInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      goToCustomRoom();
    }
  });

  clearConfirmModal.addEventListener("click", (event) => {
    if (event.target === clearConfirmModal) {
      setModalOpen(clearConfirmModal, false);
    }
  });

  newRoomModal.addEventListener("click", (event) => {
    if (event.target === newRoomModal) {
      setModalOpen(newRoomModal, false);
    }
  });

  document.addEventListener("keydown", handleGlobalKeydown);

  window.addEventListener("pageshow", () => {
    scheduleForegroundSync();
  });

  window.addEventListener("focus", () => {
    scheduleForegroundSync();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleForegroundSync();
    }
  });

  const handlePreviewViewportChange = () => {
    const nextIsCompactPreview = compactPreviewQuery.matches;
    if (nextIsCompactPreview === isCompactPreview) {
      return;
    }

    isCompactPreview = nextIsCompactPreview;
    renderItems(currentItems);
  };

  if (typeof compactPreviewQuery.addEventListener === "function") {
    compactPreviewQuery.addEventListener("change", handlePreviewViewportChange);
  } else if (typeof compactPreviewQuery.addListener === "function") {
    compactPreviewQuery.addListener(handlePreviewViewportChange);
  }

  window.addEventListener("beforeunload", closeRealtimeSync);
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape" && activeModal) {
    event.preventDefault();
    setModalOpen(activeModal, false);
    return;
  }

  if (event.key === "Tab" && activeModal) {
    trapModalFocus(activeModal, event);
  }
}

function trapModalFocus(modal, event) {
  const focusableElements = Array.from(
    modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element instanceof HTMLElement);

  if (focusableElements.length === 0) {
    return;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];
  const activeElement = document.activeElement;

  if (!(activeElement instanceof HTMLElement) || !modal.contains(activeElement)) {
    event.preventDefault();
    firstElement.focus();
    return;
  }

  if (event.shiftKey && activeElement === firstElement) {
    event.preventDefault();
    lastElement.focus();
    return;
  }

  if (!event.shiftKey && activeElement === lastElement) {
    event.preventDefault();
    firstElement.focus();
  }
}

function getMinInputHeight() {
  const minHeight = Number.parseFloat(window.getComputedStyle(inputArea).minHeight);
  return Number.isFinite(minHeight) ? minHeight : 180;
}

function autoResize() {
  inputArea.style.height = "auto";
  inputArea.style.height = `${Math.max(getMinInputHeight(), inputArea.scrollHeight)}px`;
}

function clearAutoSendTimer() {
  if (!autoSendTimer) {
    return;
  }

  window.clearTimeout(autoSendTimer);
  autoSendTimer = null;
}

function scheduleAutoSend(delay = AUTO_SEND_DELAY) {
  clearAutoSendTimer();

  if (isComposing || !inputArea.value.trim()) {
    return;
  }

  autoSendTimer = window.setTimeout(() => {
    autoSendTimer = null;
    sendItem();
  }, delay);
}

function buildApiUrl(path, { bust = false } = {}) {
  const basePath = API_BASE ? `${API_BASE}${path}` : path;
  const url = new URL(basePath, window.location.origin);
  url.searchParams.set("room", ROOM_ID);

  if (bust) {
    url.searchParams.set("_", Date.now().toString());
  }

  return url.toString();
}

function queueLoad(options = {}) {
  queuedLoadOptions = {
    manual: Boolean(options.manual) || Boolean(queuedLoadOptions?.manual),
    forceFresh: Boolean(options.forceFresh) || Boolean(queuedLoadOptions?.forceFresh),
  };
}

function areItemsEqual(prevItems, nextItems) {
  if (!Array.isArray(prevItems) || !Array.isArray(nextItems)) {
    return false;
  }
  if (prevItems.length !== nextItems.length) {
    return false;
  }

  for (let i = 0; i < prevItems.length; i += 1) {
    const prev = prevItems[i] || {};
    const next = nextItems[i] || {};
    if (
      prev.id !== next.id ||
      prev.content !== next.content ||
      prev.created_at !== next.created_at
    ) {
      return false;
    }
  }

  return true;
}

function scheduleForegroundSync() {
  const now = Date.now();
  if (now - lastForegroundSyncAt < FOREGROUND_SYNC_COOLDOWN_MS) {
    return;
  }

  lastForegroundSyncAt = now;
  loadItems({ forceFresh: true });
  ensureRealtimeSync();
}

async function loadItems(options = {}) {
  const { manual = false, forceFresh = false } = options;

  if (isLoading) {
    queueLoad({ manual, forceFresh });
    return;
  }

  isLoading = true;

  try {
    const response = await fetch(buildApiUrl("/api/items", { bust: forceFresh }), {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    if (!response.ok) {
      throw new Error("加载失败");
    }

    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : [];
    if (!areItemsEqual(currentItems, items)) {
      renderItems(items);
    }
  } catch (error) {
    if (manual) {
      showToast("加载失败", "error");
    }
    console.error("Failed to load items:", error);
  } finally {
    isLoading = false;

    if (queuedLoadOptions) {
      const nextOptions = queuedLoadOptions;
      queuedLoadOptions = null;
      loadItems(nextOptions);
    }
  }
}

async function sendItem({ successMessage = "已同步" } = {}) {
  const content = inputArea.value.trim();
  if (!content) {
    return false;
  }

  clearAutoSendTimer();

  if (isSending) {
    pendingAutoSend = true;
    return false;
  }

  isSending = true;

  try {
    const response = await fetch(buildApiUrl("/api/items"), {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({ content }),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      throw new Error(payload?.error || "发送失败");
    }

    if (inputArea.value.trim() === content) {
      inputArea.value = "";
      autoResize();
      inputArea.focus();
    } else if (!activeModal) {
      scheduleAutoSend();
    }

    showToast(successMessage, "success");

    await loadItems({ forceFresh: true });
    return true;
  } catch (error) {
    showToast(error.message || "发送失败", "error");
    return false;
  } finally {
    isSending = false;

    if (pendingAutoSend) {
      pendingAutoSend = false;
      if (!activeModal) {
        scheduleAutoSend(200);
      }
    }
  }
}

async function deleteItem(id, itemEl) {
  const deleteButton = itemEl.querySelector(".del-btn");
  if (deleteButton && deleteButton.dataset.confirming !== "true") {
    deleteButton.dataset.confirming = "true";
    deleteButton.textContent = "确认删除";
    deleteButton.classList.add("confirming");

    window.setTimeout(() => {
      if (deleteButton.dataset.confirming === "true") {
        deleteButton.dataset.confirming = "false";
        deleteButton.textContent = "删除";
        deleteButton.classList.remove("confirming");
      }
    }, 3000);

    return;
  }

  try {
    const response = await fetch(buildApiUrl(`/api/items/${id}`), {
      method: "DELETE",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      throw new Error("删除失败");
    }

    showToast("已删除", "success");
    await loadItems({ forceFresh: true });
  } catch (error) {
    showToast("删除失败", "error");
  }
}

function openClearConfirmModal() {
  const count = getCurrentItemCount();
  if (count === 0) {
    showToast("当前没有可清空的内容", "error");
    return;
  }

  syncClearConfirmState(count);
  setModalOpen(clearConfirmModal, true);
}

async function confirmClearItems() {
  const count = getCurrentItemCount();
  if (count === 0) {
    syncClearConfirmState(0);
    showToast("当前没有可清空的内容", "error");
    return;
  }

  isClearing = true;
  syncClearConfirmState(count);

  try {
    const response = await fetch(buildApiUrl("/api/items/clear"), {
      method: "POST",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      throw new Error("清空失败");
    }

    setModalOpen(clearConfirmModal, false);
    showToast("已清空", "success");
    await loadItems({ forceFresh: true });
  } catch (error) {
    showToast("清空失败", "error");
  } finally {
    isClearing = false;
    syncClearConfirmState();
  }
}

function getCurrentItemCount() {
  return itemList.querySelectorAll(".clip-item").length;
}

function getPreviewLimit() {
  return isCompactPreview ? MOBILE_PREVIEW_LIMIT : DESKTOP_PREVIEW_LIMIT;
}

function buildPreviewText(content) {
  const normalized = content.replace(/\s+/g, " ").trim();
  const previewLimit = getPreviewLimit();

  if (normalized.length <= previewLimit) {
    return {
      text: normalized || content,
      truncated: false,
    };
  }

  return {
    text: `${normalized.slice(0, previewLimit).trimEnd()}...`,
    truncated: true,
  };
}

function syncClearConfirmState(count = getCurrentItemCount()) {
  const hasItems = count > 0;
  clearConfirmCount.textContent = hasItems ? `${count} 条记录` : "暂无内容";
  btnConfirmClear.disabled = isClearing || !hasItems;
  btnConfirmClear.textContent = isClearing ? "清空中..." : "确认清空";
}

function renderItems(items) {
  currentItems = Array.isArray(items) ? items.slice() : [];
  itemList.querySelectorAll(".clip-item").forEach((itemEl) => itemEl.remove());

  itemCount.textContent = `${currentItems.length} 条记录`;
  emptyState.style.display = currentItems.length === 0 ? "" : "none";

  if (currentItems.length === 0) {
    syncClearConfirmState(0);
    return;
  }

  const fragment = document.createDocumentFragment();
  currentItems.forEach((item) => fragment.appendChild(createItemElement(item)));
  itemList.appendChild(fragment);
  syncClearConfirmState(currentItems.length);
}

function createItemElement(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "clip-item";
  wrapper.dataset.id = item.id;

  const content = String(item.content || "");
  const preview = buildPreviewText(content);
  const shouldCollapse = preview.truncated;

  const contentEl = document.createElement("div");
  contentEl.className = `clip-content${shouldCollapse ? " collapsed" : ""}`;
  contentEl.textContent = preview.text;
  wrapper.appendChild(contentEl);

  if (shouldCollapse) {
    const expandButton = document.createElement("button");
    expandButton.className = "expand-btn";
    expandButton.type = "button";
    expandButton.textContent = "展开全文";
    expandButton.addEventListener("click", () => {
      const collapsed = contentEl.classList.contains("collapsed");

      if (collapsed) {
        contentEl.textContent = content;
        contentEl.classList.remove("collapsed");
        expandButton.textContent = "收起";
        return;
      }

      contentEl.textContent = preview.text;
      contentEl.classList.add("collapsed");
      expandButton.textContent = "展开全文";
    });
    wrapper.appendChild(expandButton);
  }

  const metaEl = document.createElement("div");
  metaEl.className = "clip-meta";

  const timeEl = document.createElement("span");
  timeEl.className = "clip-time";
  timeEl.textContent = formatTime(item.created_at);
  metaEl.appendChild(timeEl);

  const actionsEl = document.createElement("div");
  actionsEl.className = "clip-actions";

  const copyButton = document.createElement("button");
  copyButton.className = "clip-action-btn copy-btn";
  copyButton.type = "button";
  copyButton.textContent = "复制";
  copyButton.addEventListener("click", async () => {
    await copyText(content, "已复制到剪贴板");
    copyButton.textContent = "已复制";
    copyButton.classList.add("copied");

    window.setTimeout(() => {
      copyButton.textContent = "复制";
      copyButton.classList.remove("copied");
    }, 1500);
  });
  actionsEl.appendChild(copyButton);

  const deleteButton = document.createElement("button");
  deleteButton.className = "clip-action-btn del-btn";
  deleteButton.type = "button";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => deleteItem(item.id, wrapper));
  actionsEl.appendChild(deleteButton);

  metaEl.appendChild(actionsEl);
  wrapper.appendChild(metaEl);

  return wrapper;
}

function formatTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diff = Date.now() - date.getTime();
  if (diff < 60_000) {
    return "刚刚";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  if (diff < 604_800_000) {
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }

  return date.toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function copyText(text, successMessage = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }

  showToast(successMessage, "success");
}

function showToast(message, type = "") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  toastContainer.appendChild(toast);
  window.setTimeout(() => toast.remove(), 2500);
}

function setModalOpen(modal, show) {
  if (!modal) {
    return;
  }

  if (show) {
    clearAutoSendTimer();

    if (activeModal && activeModal !== modal) {
      setModalOpen(activeModal, false);
    }

    activeModal = modal;
    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.classList.add("active");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    const focusTarget = modal.querySelector("[data-modal-focus], input, textarea, button");
    if (focusTarget instanceof HTMLElement) {
      window.setTimeout(() => focusTarget.focus(), 100);
    }
    return;
  }

  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");

  if (activeModal === modal) {
    activeModal = null;
  }

  if (!document.querySelector(".modal-overlay.active")) {
    document.body.classList.remove("modal-open");
  }

  const focusTarget = lastFocusedElement;
  lastFocusedElement = null;
  if (focusTarget instanceof HTMLElement && document.contains(focusTarget)) {
    focusTarget.focus();
  }

  if (!activeModal && inputArea.value.trim() && !isSending && !isComposing) {
    scheduleAutoSend();
  }
}

function loadQr() {
  const url = window.location.href;
  const displayUrl = url.replace(/^https?:\/\//, "");
  qrContainer.innerHTML = `<img src="/api/qr?text=${encodeURIComponent(url)}" alt="房间二维码">`;
  qrUrl.textContent = displayUrl;
  qrUrl.title = url;
}

function normalizeRoomId(value) {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

function openNewRoomModal() {
  newRoomCustomInput.value = "";
  setModalOpen(newRoomModal, true);
}

function goToRandomRoom() {
  window.location.href = "/";
}

function goToCustomRoom() {
  const roomId = normalizeRoomId(newRoomCustomInput.value.trim());
  newRoomCustomInput.value = roomId;

  if (!roomId) {
    showToast("请输入房间号", "error");
    newRoomCustomInput.focus();
    return;
  }

  if (!CUSTOM_ROOM_PATTERN.test(roomId)) {
    showToast("房间号仅支持字母、数字、_ 和 -", "error");
    newRoomCustomInput.focus();
    return;
  }

  if (roomId === ROOM_ID) {
    setModalOpen(newRoomModal, false);
    showToast("已经在当前房间", "success");
    return;
  }

  window.location.href = `/r/${encodeURIComponent(roomId)}`;
}

function startRealtimeSync() {
  if (!("EventSource" in window)) {
    startPolling();
    return;
  }

  connectRealtimeStream();
}

function ensureRealtimeSync() {
  if ("EventSource" in window) {
    if (!realtimeSource) {
      connectRealtimeStream();
    }
    return;
  }

  startPolling();
}

function connectRealtimeStream() {
  closeRealtimeSync();

  realtimeSource = new EventSource(buildApiUrl("/api/stream"));
  realtimeSource.addEventListener("ready", () => {
    stopPolling();
    loadItems({ forceFresh: true });
  });
  realtimeSource.addEventListener("items_changed", () => {
    loadItems({ forceFresh: true });
  });
  realtimeSource.onerror = () => {
    closeRealtimeSync();
    startPolling();
    scheduleReconnect();
  };
}

function closeRealtimeSync() {
  if (realtimeSource) {
    realtimeSource.close();
    realtimeSource = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    ensureRealtimeSync();
  }, STREAM_RETRY_DELAY);
}

function startPolling() {
  if (pollTimer) {
    return;
  }

  pollTimer = window.setInterval(() => {
    if (!document.hidden) {
      loadItems({ forceFresh: true });
    }
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (!pollTimer) {
    return;
  }

  window.clearInterval(pollTimer);
  pollTimer = null;
}
