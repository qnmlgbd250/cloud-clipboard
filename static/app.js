const scriptEl = document.currentScript || document.querySelector("script[data-room]");
const ROOM_ID = scriptEl?.dataset.room || "";
const ITEMS_PAGE_SIZE = 20;
const POLL_INTERVAL = 5000;
const STREAM_RETRY_DELAY = 2000;
const AUTO_SEND_DELAY = 1000;
const FOREGROUND_SYNC_COOLDOWN_MS = 800;
const FILE_SIZE_LIMIT_BYTES = 500 * 1024 * 1024;
const MOBILE_PREVIEW_LIMIT = 56;
const DESKTOP_PREVIEW_LIMIT = 150;
const AUTO_LOAD_ROOT_MARGIN = "240px 0px";
const CUSTOM_ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const compactPreviewQuery = window.matchMedia("(max-width: 560px)");

const $ = (selector) => document.querySelector(selector);
const inputSection = $("#inputSection");
const inputArea = $("#inputArea");
const btnClear = $("#btnClear");
const btnNewRoom = $("#btnNewRoom");
const itemList = $("#itemList");
const emptyState = $("#emptyState");
const emptyStateTitle = emptyState?.querySelector("p");
const emptyStateHint = emptyState?.querySelector(".empty-hint");
const itemCount = $("#itemCount");
const itemFeedFooter = $("#itemFeedFooter");
const itemLoadStatus = $("#itemLoadStatus");
const loadMoreSentinel = $("#loadMoreSentinel");
const roomBadge = $("#roomBadge");
const qrContainer = $("#qrContainer");
const newRoomModal = $("#newRoomModal");
const toastContainer = $("#toastContainer");
const btnCloseNewRoomModal = $("#btnCloseNewRoomModal");
const btnCreateRandomRoom = $("#btnCreateRandomRoom");
const btnCreateCustomRoom = $("#btnCreateCustomRoom");
const newRoomCustomInput = $("#newRoomCustomInput");
const btnModeText = $("#btnModeText");
const btnModeFile = $("#btnModeFile");
const textComposer = $("#textComposer");
const fileComposer = $("#fileComposer");
const fileInput = $("#fileInput");
const fileDropzone = $("#fileDropzone");
const uploadProgress = $("#uploadProgress");
const uploadProgressValue = $("#uploadProgressValue");
const uploadProgressText = $("#uploadProgressText");

let isLoading = false;
let queuedLoadOptions = null;
let realtimeSource = null;
let reconnectTimer = null;
let pollTimer = null;
let lastReconnectAttempt = 0;
const RECONNECT_COOLDOWN_MS = 10000;
let pendingItemsChanged = false;
let itemsChangedTimer = null;
let activeModal = null;
let lastFocusedElement = null;
let isClearing = false;
let isSending = false;
let isUploading = false;
let isComposing = false;
let autoSendTimer = null;
let pendingAutoSend = false;
let currentItems = [];
let totalItems = 0;
let hasMoreItems = false;
let cachedDisplayItems = null;
let cachedDisplayItemsVersion = 0;
let lastItemsRef = null;
let isLoadingMore = false;
let loadMoreObserver = null;
let isCompactPreview = compactPreviewQuery.matches;
let lastForegroundSyncAt = 0;
let lastSuccessfulLoadAt = 0;
let currentMode = "text";

roomBadge.textContent = ROOM_ID;
roomBadge.title = `点击复制房间链接：${ROOM_ID}`;
autoResize();
bindEvents();
setupLoadMoreObserver();
loadQr();
setMode("text");
loadItems({ forceFresh: true });
startRealtimeSync();

function bindEvents() {
  inputSection.addEventListener("click", (event) => {
    if (currentMode !== "text") return;
    if (!(event.target instanceof HTMLElement) || event.target.closest("button")) return;
    inputArea.focus();
  });

  inputArea.addEventListener("input", () => {
    autoResize();
    if (!isComposing && currentMode === "text") scheduleAutoSend();
  });
  inputArea.addEventListener("compositionstart", () => {
    isComposing = true;
    clearAutoSendTimer();
  });
  inputArea.addEventListener("compositionend", () => {
    isComposing = false;
    autoResize();
    if (currentMode === "text") scheduleAutoSend();
  });
  inputArea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      sendTextItem({ successMessage: "已发送" });
    }
  });

  btnClear.addEventListener("click", handleClearClick);
  btnNewRoom.addEventListener("click", openNewRoomModal);
  roomBadge.addEventListener("click", () => {
    copyText(window.location.href, "链接已复制");
    roomBadge.classList.add("copied");
    window.setTimeout(() => roomBadge.classList.remove("copied"), 1500);
  });
  btnModeText.addEventListener("click", () => setMode("text"));
  btnModeFile.addEventListener("click", () => setMode("file"));
  fileInput.addEventListener("change", handleFileSelection);
  fileDropzone.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) return;
    fileInput.click();
  });
  fileDropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileDropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    fileDropzone.classList.add("dragover");
  });
  fileDropzone.addEventListener("dragleave", () => fileDropzone.classList.remove("dragover"));
  fileDropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    fileDropzone.classList.remove("dragover");
    const [file] = Array.from(event.dataTransfer?.files || []);
    if (file) uploadFile(file);
  });

  btnCloseNewRoomModal.addEventListener("click", () => setModalOpen(newRoomModal, false));
  btnCreateRandomRoom.addEventListener("click", goToRandomRoom);
  btnCreateCustomRoom.addEventListener("click", goToCustomRoom);
  newRoomCustomInput.addEventListener("input", () => {
    const normalized = normalizeRoomId(newRoomCustomInput.value);
    if (newRoomCustomInput.value !== normalized) newRoomCustomInput.value = normalized;
  });
  newRoomCustomInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      goToCustomRoom();
    }
  });

  newRoomModal.addEventListener("click", (event) => {
    if (event.target === newRoomModal) setModalOpen(newRoomModal, false);
  });
  document.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("pageshow", scheduleForegroundSync);
  window.addEventListener("focus", scheduleForegroundSync);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleForegroundSync();
  });
  const handlePreviewChange = () => {
    const nextIsCompactPreview = compactPreviewQuery.matches;
    if (nextIsCompactPreview === isCompactPreview) return;
    isCompactPreview = nextIsCompactPreview;
    renderItems(currentItems);
  };
  if (typeof compactPreviewQuery.addEventListener === "function") compactPreviewQuery.addEventListener("change", handlePreviewChange);
  else if (typeof compactPreviewQuery.addListener === "function") compactPreviewQuery.addListener(handlePreviewChange);
  window.addEventListener("beforeunload", closeRealtimeSync);
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape" && activeModal) {
    event.preventDefault();
    setModalOpen(activeModal, false);
    return;
  }
  if (event.key === "Tab" && activeModal) trapModalFocus(activeModal, event);
}

function trapModalFocus(modal, event) {
  const focusableElements = Array.from(modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((element) => element instanceof HTMLElement);
  if (focusableElements.length === 0) return;
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
  if (!autoSendTimer) return;
  window.clearTimeout(autoSendTimer);
  autoSendTimer = null;
}

function scheduleAutoSend(delay = AUTO_SEND_DELAY) {
  clearAutoSendTimer();
  if (currentMode !== "text" || isComposing || !inputArea.value.trim()) return;
  autoSendTimer = window.setTimeout(() => {
    autoSendTimer = null;
    sendTextItem();
  }, delay);
}

function buildApiUrl(path, { bust = false, params = {} } = {}) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("room", ROOM_ID);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  if (bust) url.searchParams.set("_", Date.now().toString());
  return url.toString();
}

function queueLoad(options = {}) {
  const nextLimit = Number.isFinite(options.limit) ? options.limit : 0;
  queuedLoadOptions = {
    manual: Boolean(options.manual) || Boolean(queuedLoadOptions?.manual),
    forceFresh: Boolean(options.forceFresh) || Boolean(queuedLoadOptions?.forceFresh),
    limit: Math.max(nextLimit, queuedLoadOptions?.limit || 0) || undefined,
  };
}

function fingerprintItem(item) {
  return `${item.id}|${item.type}|${item.created_at}|${item.updated_at || ""}|${item.content != null ? String(item.content).length : item.size || 0}`;
}

function areItemsEqual(prevItems, nextItems) {
  if (!Array.isArray(prevItems) || !Array.isArray(nextItems) || prevItems.length !== nextItems.length) return false;
  return prevItems.every((item, index) => fingerprintItem(item) === fingerprintItem(nextItems[index]));
}

function getVisibleItemTarget() {
  return Math.max(currentItems.length, ITEMS_PAGE_SIZE);
}

function normalizeItemsPayload(payload, { offset = 0, limit = ITEMS_PAGE_SIZE } = {}) {
  if (Array.isArray(payload)) return { items: payload, total: payload.length, hasMore: false, offset, limit };
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const total = Number.isFinite(payload?.total) ? Math.max(payload.total, items.length) : items.length;
  const safeOffset = Number.isFinite(payload?.offset) ? Math.max(payload.offset, 0) : offset;
  const safeLimit = Number.isFinite(payload?.limit) ? Math.max(payload.limit, items.length) : limit;
  const hasMore = typeof payload?.has_more === "boolean" ? payload.has_more : safeOffset + items.length < total;
  return { items, total, hasMore, offset: safeOffset, limit: safeLimit };
}

function applyItems(items, { total = items.length, hasMore = false } = {}) {
  const nextItems = Array.isArray(items) ? items : [];
  const nextTotal = Number.isFinite(total) ? Math.max(total, nextItems.length) : nextItems.length;
  const nextHasMore = Boolean(hasMore) && nextItems.length < nextTotal;
  if (areItemsEqual(currentItems, nextItems) && totalItems === nextTotal && hasMoreItems === nextHasMore) return false;
  
  const changes = quickDiff(currentItems, nextItems);
  const wasEmpty = currentItems.length === 0;
  currentItems = nextItems.slice();
  totalItems = nextTotal;
  hasMoreItems = nextHasMore;

  if (changes.op !== "full" && !wasEmpty && itemList.querySelector(".item-section")) {
    patchItemDOM(changes);
  } else {
    renderItems(nextItems);
  }

  // Update count and state
  const displayItems = getCachedDisplayItems();
  itemCount.textContent = currentMode === "file" ? `${displayItems.length} 个文件` : `${displayItems.length} 条文本`;
  btnClear.disabled = displayItems.length === 0;
  syncClearConfirmState(totalItems);
  updateLoadMoreState();
  updateAllTimeLabels();
  return true;
}

function updateAllTimeLabels() {
  document.querySelectorAll(".clip-time").forEach(el => {
    const createdAt = el.dataset.createdAt;
    if (!createdAt) return;
    const size = el.dataset.size;
    if (size !== undefined) {
      el.textContent = `${formatFileSize(size)} · ${formatTime(createdAt)}`;
    } else {
      el.textContent = formatTime(createdAt);
    }
  });
}

function quickDiff(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return { op: "full" };
  const prevMap = new Map();
  for (const i of prev) prevMap.set(i.id, i);
  const nextIds = new Set();
  const removed = [];
  for (const i of next) nextIds.add(i.id);
  for (const i of prev) if (!nextIds.has(i.id)) removed.push(i);
  const added = [];
  for (const i of next) {
    if (!prevMap.has(i.id)) { added.push(i); continue; }
    if (fingerprintItem(prevMap.get(i.id)) !== fingerprintItem(i)) return { op: "full" };
  }
  // Only patch if it's a single addition or removal to avoid complex order issues
  if (added.length + removed.length > 1) return { op: "full" };
  return { op: "patch", added, removed };
}

function patchItemDOM(changes) {
  changes.removed.forEach(item => {
    const el = itemList.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
    if (el) el.remove();
  });
  
  changes.added.forEach(item => {
    const display = currentMode === "file" ? item.type === "file" : item.type !== "file";
    if (!display) return;
    const section = itemList.querySelector(".item-section");
    const content = section?.querySelector(".item-section-content");
    if (content) {
      content.insertBefore(createItemElement(item), content.firstChild);
    } else {
      renderItems(currentItems);
    }
  });

  // Remove empty .item-section if no children left
  itemList.querySelectorAll(".item-section").forEach(section => {
    if (!section.querySelector(".clip-item")) section.remove();
  });
}

function appendItems(items, { total = totalItems, hasMore = false } = {}) {
  const mergedItems = currentItems.slice();
  const seenIds = new Set(mergedItems.map((item) => item.id));
  items.forEach((item) => {
    if (seenIds.has(item.id)) return;
    mergedItems.push(item);
    seenIds.add(item.id);
  });
  return applyItems(mergedItems, { total, hasMore });
}

function scheduleForegroundSync() {
  const now = Date.now();
  if (now - lastForegroundSyncAt < FOREGROUND_SYNC_COOLDOWN_MS) return;
  lastForegroundSyncAt = now;
  loadItems({ forceFresh: true, limit: getVisibleItemTarget() });
  ensureRealtimeSync();
}

async function loadItems(options = {}) {
  const { manual = false, forceFresh = false, append = false, limit = ITEMS_PAGE_SIZE } = options;
  if (append && (isLoading || isLoadingMore || !hasMoreItems)) return false;
  if (!append && (isLoading || isLoadingMore)) {
    queueLoad({ manual, forceFresh, limit });
    return false;
  }
  if (append) isLoadingMore = true;
  else isLoading = true;
  updateLoadMoreState();
  try {
    const offset = append ? currentItems.length : 0;
    const response = await fetch(buildApiUrl("/api/items", { bust: forceFresh, params: { offset, limit: Math.max(1, limit) } }), {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    });
    if (!response.ok) throw new Error("加载失败");
    const payload = await response.json();
    const page = normalizeItemsPayload(payload, { offset, limit });
    lastSuccessfulLoadAt = Date.now();
    if (append) appendItems(page.items, { total: page.total, hasMore: page.hasMore });
    else applyItems(page.items, { total: page.total, hasMore: page.hasMore });
    return true;
  } catch (error) {
    if (manual) showToast(error.message || "加载失败", "error");
    console.error(error);
    return false;
  } finally {
    if (append) isLoadingMore = false;
    else isLoading = false;
    updateLoadMoreState();
    if (!isLoading && !isLoadingMore && queuedLoadOptions) {
      const nextOptions = queuedLoadOptions;
      queuedLoadOptions = null;
      loadItems(nextOptions);
    }
  }
}

async function sendTextItem({ successMessage = "已同步" } = {}) {
  const content = inputArea.value.trim();
  if (!content) return false;
  clearAutoSendTimer();
  if (isSending || isUploading) {
    pendingAutoSend = true;
    return false;
  }
  isSending = true;
  try {
    const response = await fetch(buildApiUrl("/api/items"), {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify({ content }),
    });
    const payload = await safeReadJson(response);
    if (!response.ok) throw new Error(payload?.error || "发送失败");
    if (inputArea.value.trim() === content) {
      inputArea.value = "";
      autoResize();
      if (currentMode === "text") inputArea.focus();
    }
    showToast(successMessage, "success");
    prependNewItem(payload);
    return true;
  } catch (error) {
    showToast(error.message || "发送失败", "error");
    return false;
  } finally {
    isSending = false;
    if (pendingAutoSend) {
      pendingAutoSend = false;
      if (!activeModal) scheduleAutoSend(200);
    }
  }
}



function uploadFileWithProgress(file) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", buildApiUrl("/api/files"));
    xhr.responseType = "text";
    xhr.setRequestHeader("Cache-Control", "no-cache");
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      setUploadProgress((event.loaded / event.total) * 100);
    });
    xhr.addEventListener("load", () => {
      const payload = safeParseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      reject(new Error(payload?.error || "上传失败"));
    });
    xhr.addEventListener("error", () => reject(new Error("上传失败")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消")));
    xhr.send(formData);
  });
}

function prependNewItem(item) {
  if (!item || typeof item !== "object") {
    queueLoad({ forceFresh: true, limit: getVisibleItemTarget() });
    return;
  }
  const nextTotal = currentItems.some((currentItem) => currentItem.id === item.id) ? totalItems : totalItems + 1;
  applyItems([item, ...currentItems.filter((currentItem) => currentItem.id !== item.id)].slice(0, getVisibleItemTarget()), {
    total: Math.max(nextTotal, 1),
    hasMore: nextTotal > getVisibleItemTarget(),
  });
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function safeParseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
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
    const visibleTarget = getVisibleItemTarget();
    const response = await fetch(buildApiUrl(`/api/items/${encodeURIComponent(id)}`), {
      method: "DELETE",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) throw new Error("删除失败");
    if (deleteButton) {
      deleteButton.textContent = "已删除";
      deleteButton.classList.remove("confirming");
      deleteButton.dataset.confirming = "false";
    }
    const nextTotal = Math.max(totalItems - 1, 0);
    // Full re-fetch to get server-sorted data
    loadItems({ forceFresh: true, limit: Math.max(visibleTarget, nextTotal) });
  } catch {
    if (deleteButton) {
      deleteButton.textContent = "删除";
      deleteButton.classList.remove("confirming");
      deleteButton.dataset.confirming = "false";
    }
    showToast("删除失败", "error");
  }
}

function handleClearClick() {
  if (btnClear.dataset.confirming !== "true") {
    const currentCount = getCurrentItemCount();
    if (currentCount === 0) return;
    btnClear.dataset.confirming = "true";
    btnClear.textContent = "确认清空";
    btnClear.classList.add("confirming");
    window.setTimeout(() => {
      if (btnClear.dataset.confirming === "true") {
        btnClear.dataset.confirming = "false";
        btnClear.textContent = "清空";
        btnClear.classList.remove("confirming");
      }
    }, 3000);
    return;
  }
  btnClear.textContent = "清空中...";
  btnClear.classList.remove("confirming");
  btnClear.dataset.confirming = "false";
  btnClear.disabled = true;
  doClearItems();
}

async function doClearItems() {
  try {
    const response = await fetch(buildApiUrl("/api/items/clear", { params: { type: currentMode } }), {
      method: "POST",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) throw new Error("清空失败");
    btnClear.textContent = "已清空";
    window.setTimeout(() => {
      btnClear.textContent = "清空";
    }, 1500);
    loadItems({ forceFresh: true, limit: getVisibleItemTarget() });
  } catch {
    btnClear.textContent = "清空失败";
    window.setTimeout(() => {
      btnClear.textContent = "清空";
    }, 1500);
  } finally {
    isClearing = false;
    btnClear.disabled = false;
  }
}

function getCurrentItemCount() {
  return getCachedDisplayItems().length;
}

function getPreviewLimit() {
  return isCompactPreview ? MOBILE_PREVIEW_LIMIT : DESKTOP_PREVIEW_LIMIT;
}

function buildPreviewText(content) {
  const normalized = String(content || "").replace(/\s+/g, " ").trim();
  const previewLimit = getPreviewLimit();
  if (normalized.length <= previewLimit) return { text: normalized || String(content || ""), truncated: false };
  return { text: `${normalized.slice(0, previewLimit).trimEnd()}...`, truncated: true };
}

function syncClearConfirmState(count = getCurrentItemCount()) {
  btnClear.disabled = count === 0;
}

function getDisplayItems(items = currentItems) {
  const sourceItems = Array.isArray(items) ? items : [];
  return currentMode === "file" ? sourceItems.filter((item) => item.type === "file") : sourceItems.filter((item) => item.type !== "file");
}

function getCachedDisplayItems() {
  if (cachedDisplayItems && lastItemsRef === currentItems && cachedDisplayItemsVersion === currentItems.length) {
    return cachedDisplayItems;
  }
  cachedDisplayItems = getDisplayItems(currentItems);
  cachedDisplayItemsVersion = currentItems.length;
  lastItemsRef = currentItems;
  return cachedDisplayItems;
}

function invalidateDisplayCache() {
  cachedDisplayItems = null;
  lastItemsRef = null;
}

function getCurrentModeLabel() {
  return currentMode === "file" ? "文件" : "文本";
}

function updateEmptyState() {
  if (!emptyStateTitle || !emptyStateHint) return;
  if (totalItems === 0) {
    emptyStateTitle.textContent = "还没有内容";
    emptyStateHint.textContent = "可以发送文本，也可以上传文件，再在其他设备上打开同一个房间。";
    return;
  }
  if (currentMode === "file") {
    emptyStateTitle.textContent = "当前没有文件";
    emptyStateHint.textContent = "这个房间里暂时还没有文件，切换到文本页仍可查看已发送的文字内容。";
    return;
  }
  emptyStateTitle.textContent = "当前没有文本";
  emptyStateHint.textContent = "这个房间里暂时还没有文本，切换到文件页可查看已上传的文件。";
}

function updateLoadMoreState() {
  const displayItems = getCachedDisplayItems();
  if (displayItems.length === 0) {
    itemFeedFooter.hidden = true;
    return;
  }
  itemFeedFooter.hidden = !hasMoreItems;
}

function renderItems(items) {
  currentItems = Array.isArray(items) ? items.slice() : [];
  invalidateDisplayCache();
  const displayItems = getCachedDisplayItems();
  itemCount.textContent = currentMode === "file" ? `${displayItems.length} 个文件` : `${displayItems.length} 条文本`;
  btnClear.disabled = displayItems.length === 0;
  if (displayItems.length === 0) {
    updateEmptyState();
    emptyState.style.display = "";
    itemList.replaceChildren(emptyState);
    syncClearConfirmState(totalItems);
    updateLoadMoreState();
    return;
  }
  emptyState.style.display = "none";
  const fragment = document.createDocumentFragment();
  const section = document.createElement("section");
  section.className = "item-section";
  const content = document.createElement("div");
  content.className = "item-section-content";
  displayItems.forEach((item) => content.appendChild(createItemElement(item)));
  section.appendChild(content);
  fragment.appendChild(section);
  itemList.replaceChildren(fragment);
  syncClearConfirmState(totalItems);
  updateLoadMoreState();
}

function createItemSection(items) {
  const section = document.createElement("section");
  section.className = "item-section";
  const content = document.createElement("div");
  content.className = "item-section-content";
  items.forEach((item) => content.appendChild(createItemElement(item)));
  section.appendChild(content);
  return section;
}

// Kept for potential external use; renderItems now inlines this for perf.

function createItemElement(item) {
  const wrapper = document.createElement("div");
  wrapper.className = `clip-item${item.type === "file" ? " clip-item-file" : ""}`;
  wrapper.dataset.id = item.id;
  if (item.type === "file") renderFileContent(wrapper, item);
  else renderTextContent(wrapper, item);
  const metaEl = document.createElement("div");
  metaEl.className = "clip-meta";
  const timeEl = document.createElement("span");
  timeEl.className = "clip-time";
  timeEl.dataset.createdAt = item.created_at;
  if (item.type === "file") timeEl.dataset.size = item.size;
  timeEl.textContent = item.type === "file" ? `${formatFileSize(item.size)} · ${formatTime(item.created_at)}` : formatTime(item.created_at);
  metaEl.appendChild(timeEl);
  const actionsEl = document.createElement("div");
  actionsEl.className = "clip-actions";
  if (item.type === "file") {
    actionsEl.appendChild(createActionButton("下载", "", () => downloadFile(item)));
  } else {
    const copyButton = createActionButton("复制", "copy-btn", async () => {
      await copyText(String(item.content || ""), "已复制到剪贴板");
      copyButton.textContent = "已复制";
      copyButton.classList.add("copied");
      window.setTimeout(() => {
        copyButton.textContent = "复制";
        copyButton.classList.remove("copied");
      }, 1500);
    });
    actionsEl.appendChild(copyButton);
  }
  actionsEl.appendChild(createActionButton("删除", "del-btn", () => deleteItem(item.id, wrapper)));
  metaEl.appendChild(actionsEl);
  wrapper.appendChild(metaEl);
  return wrapper;
}

function renderTextContent(wrapper, item) {
  const content = String(item.content || "");
  const preview = buildPreviewText(content);
  const contentEl = document.createElement("div");
  contentEl.className = `clip-content${preview.truncated ? " collapsed" : ""}`;
  contentEl.textContent = preview.text;
  wrapper.appendChild(contentEl);
  if (!preview.truncated) return;
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
    } else {
      contentEl.textContent = preview.text;
      contentEl.classList.add("collapsed");
      expandButton.textContent = "展开全文";
    }
  });
  wrapper.appendChild(expandButton);
}

function renderFileContent(wrapper, item) {
  const fileRow = document.createElement("div");
  fileRow.className = "file-row";
  const badge = document.createElement("span");
  badge.className = "file-badge";
  badge.textContent = "FILE";
  const nameEl = document.createElement("div");
  nameEl.className = "file-name";
  nameEl.textContent = String(item.filename || "未命名文件");
  fileRow.appendChild(badge);
  fileRow.appendChild(nameEl);
  wrapper.appendChild(fileRow);
}

function createActionButton(label, className, onClick) {
  const button = document.createElement("button");
  button.className = `clip-action-btn ${className}`.trim();
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function downloadFile(item) {
  const anchor = document.createElement("a");
  anchor.href = buildApiUrl(`/api/files/${encodeURIComponent(item.id)}`, { bust: true });
  anchor.download = String(item.filename || "file");
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function formatTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function copyText(text, successMessage = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

function showToast(message, type = "") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  toastContainer.appendChild(toast);
  window.setTimeout(() => toast.remove(), 2500);
}

function setModalOpen(modal, show) {
  if (!modal) return;
  if (show) {
    clearAutoSendTimer();
    if (activeModal && activeModal !== modal) setModalOpen(activeModal, false);
    activeModal = modal;
    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.classList.add("active");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    const focusTarget = modal.querySelector("[data-modal-focus], input, textarea, button");
    if (focusTarget instanceof HTMLElement) window.setTimeout(() => focusTarget.focus(), 100);
    return;
  }
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
  if (activeModal === modal) activeModal = null;
  if (!document.querySelector(".modal-overlay.active")) document.body.classList.remove("modal-open");
  const focusTarget = lastFocusedElement;
  lastFocusedElement = null;
  if (focusTarget instanceof HTMLElement && document.contains(focusTarget)) focusTarget.focus();
  if (!activeModal && currentMode === "text" && inputArea.value.trim() && !isSending && !isComposing) scheduleAutoSend();
}

function loadQr() {
  const url = window.location.href;
  qrContainer.innerHTML = `<img src="/api/qr?text=${encodeURIComponent(url)}" alt="房间二维码">`;
}

function setupLoadMoreObserver() {
  if (typeof IntersectionObserver !== "function" || !loadMoreSentinel) return;
  loadMoreObserver = new IntersectionObserver((entries) => {
    const isVisible = entries.some((entry) => entry.isIntersecting);
    if (!isVisible || document.hidden) return;
    if (window.scrollY <= 0 && currentItems.length <= ITEMS_PAGE_SIZE) return;
    loadMoreItems();
  }, { rootMargin: AUTO_LOAD_ROOT_MARGIN });
  loadMoreObserver.observe(loadMoreSentinel);
}

function loadMoreItems() {
  const remaining = Math.max(totalItems - currentItems.length, 0);
  if (remaining <= 0) {
    updateLoadMoreState();
    return Promise.resolve(false);
  }
  return loadItems({ append: true, forceFresh: true, limit: Math.min(ITEMS_PAGE_SIZE, remaining) });
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

function setMode(mode) {
  currentMode = mode === "file" ? "file" : "text";
  btnModeText.classList.toggle("active", currentMode === "text");
  btnModeText.setAttribute("aria-selected", currentMode === "text" ? "true" : "false");
  btnModeFile.classList.toggle("active", currentMode === "file");
  btnModeFile.setAttribute("aria-selected", currentMode === "file" ? "true" : "false");
  textComposer.classList.toggle("active", currentMode === "text");
  textComposer.hidden = currentMode !== "text";
  fileComposer.classList.toggle("active", currentMode === "file");
  fileComposer.hidden = currentMode !== "file";
  if (currentMode === "text") {
    window.setTimeout(() => inputArea.focus(), 30);
    if (inputArea.value.trim() && !isSending && !isComposing) scheduleAutoSend(200);
  } else {
    clearAutoSendTimer();
  }
  renderItems(currentItems);
}

function handleFileSelection(event) {
  const [file] = Array.from(event.target.files || []);
  if (!file) return;
  if (file.size > FILE_SIZE_LIMIT_BYTES) {
    showToast("文件超过 100 MB 限制", "error");
    fileInput.value = "";
    return;
  }
  uploadFile(file);
}

async function uploadFile(file) {
  if (isUploading || isSending) return;
  isUploading = true;
  try {
    const payload = await uploadFileWithProgress(file);
    showToast("文件已上传", "success");
    prependNewItem(payload);
  } catch (error) {
    showToast(error.message || "上传失败", "error");
  } finally {
    isUploading = false;
    fileInput.value = "";
    resetUploadProgress();
  }
}

function setUploadProgress(percent) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  uploadProgress.hidden = false;
  uploadProgressValue.style.width = `${safePercent}%`;
  uploadProgressText.textContent = `上传中 ${safePercent}%`;
}

function resetUploadProgress() {
  uploadProgress.hidden = true;
  uploadProgressValue.style.width = "0%";
  uploadProgressText.textContent = "上传中 0%";
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
    if (!realtimeSource) connectRealtimeStream();
    return;
  }
  startPolling();
}

function connectRealtimeStream() {
  closeRealtimeSync();
  realtimeSource = new EventSource(buildApiUrl("/api/stream"));
  realtimeSource.addEventListener("ready", () => {
    stopPolling();
    if (!lastSuccessfulLoadAt || Date.now() - lastSuccessfulLoadAt > POLL_INTERVAL) loadItems({ forceFresh: true, limit: getVisibleItemTarget() });
  });
  realtimeSource.addEventListener("items_changed", () => {
    pendingItemsChanged = true;
    if (itemsChangedTimer) return;
    itemsChangedTimer = window.setTimeout(() => {
      itemsChangedTimer = null;
      if (pendingItemsChanged) {
        pendingItemsChanged = false;
        loadItems({ forceFresh: true, limit: getVisibleItemTarget() });
      }
    }, 300);
  });
  realtimeSource.onerror = () => {
    closeRealtimeSync();
    if (Date.now() - lastReconnectAttempt < RECONNECT_COOLDOWN_MS) return;
    lastReconnectAttempt = Date.now();
    startPolling();
    scheduleReconnect();
  };
}

function closeRealtimeSync() {
  if (!realtimeSource) return;
  realtimeSource.close();
  realtimeSource = null;
  if (itemsChangedTimer) { window.clearTimeout(itemsChangedTimer); itemsChangedTimer = null; }
  pendingItemsChanged = false;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    ensureRealtimeSync();
  }, STREAM_RETRY_DELAY);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = window.setInterval(() => {
    if (!document.hidden) loadItems({ forceFresh: true, limit: getVisibleItemTarget() });
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (!pollTimer) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

window.setInterval(updateAllTimeLabels, 30000);
