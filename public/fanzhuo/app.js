(() => {
  'use strict';

  const APP_ID = 'fanzhuo';
  const STORAGE_KEY = 'fanzhuo.data.v1';
  const LEGACY_SLOTS = [
    { key: 'breakfast', label: '早餐' },
    { key: 'lunch', label: '午餐' },
    { key: 'dinner', label: '晚餐' },
  ];
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const EMBEDDED = new URLSearchParams(window.location.search).get('embed') === '1';
  const COARSE_POINTER = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
  if (EMBEDDED) document.body.classList.add('is-embedded');
  function notifyParent(message) {
    if (EMBEDDED && window.parent !== window) window.parent.postMessage(message, window.location.origin);
  }

  const dom = {
    weekGrid: $('#weekGrid'),
    heroWeekLabel: $('#heroWeekLabel'),
    plateWeek: $('#plateWeek'),
    weekRange: $('#weekRange'),
    weekHint: $('#weekHint'),
    plannerTitle: $('#plannerTitle'),
    todayButton: $('#todayButton'),
    prevWeekButton: $('#prevWeekButton'),
    nextWeekButton: $('#nextWeekButton'),
    brandButton: $('#brandButton'),
    ledgerHomeLink: $('#ledgerHomeLink'),
    statMeals: $('#statMeals'),
    statWishes: $('#statWishes'),
    statPantry: $('#statPantry'),
    statWeekCost: $('#statWeekCost'),
    weekPreview: $('#weekPreview'),
    weekPreviewTitle: $('#weekPreviewTitle'),
    weekPreviewRange: $('#weekPreviewRange'),
    weekPreviewHint: $('#weekPreviewHint'),
    wishlist: $('#wishlist'),
    wishCount: $('#wishCount'),
    pantryList: $('#pantryList'),
    pantryCount: $('#pantryCount'),
    addWishButton: $('#addWishButton'),
    addPantryButton: $('#addPantryButton'),
    exportButton: $('#exportButton'),
    importButton: $('#importButton'),
    importInput: $('#importInput'),
    saveStatus: $('#saveStatus'),
    lastSaved: $('#lastSaved'),
    mealDialog: $('#mealDialog'),
    mealDialogTitle: $('#mealDialogTitle'),
    mealForm: $('#mealForm'),
    mealTitle: $('#mealTitle'),
    mealDate: $('#mealDate'),
    mealCost: $('#mealCost'),
    mealNote: $('#mealNote'),
    mealError: $('#mealError'),
    mealSuggestions: $('#mealSuggestions'),
    mealRemoveActions: $('#mealRemoveActions'),
    saveMealButton: $('#saveMealButton'),
    deleteMealButton: $('#deleteMealButton'),
    deleteMealToWishButton: $('#deleteMealToWishButton'),
    deleteMealToPantryButton: $('#deleteMealToPantryButton'),
    wishDialog: $('#wishDialog'),
    wishDialogTitle: $('#wishDialogTitle'),
    wishForm: $('#wishForm'),
    wishName: $('#wishName'),
    wishPrice: $('#wishPrice'),
    wishNote: $('#wishNote'),
    wishError: $('#wishError'),
    saveWishButton: $('#saveWishButton'),
    deleteWishButton: $('#deleteWishButton'),
    pantryDialog: $('#pantryDialog'),
    pantryDialogTitle: $('#pantryDialogTitle'),
    pantryForm: $('#pantryForm'),
    pantryName: $('#pantryName'),
    pantryAmount: $('#pantryAmount'),
    pantryPrice: $('#pantryPrice'),
    pantryExpiry: $('#pantryExpiry'),
    pantryNote: $('#pantryNote'),
    pantryError: $('#pantryError'),
    savePantryButton: $('#savePantryButton'),
    deletePantryButton: $('#deletePantryButton'),
    toast: $('#toast'),
    toastMessage: $('#toastMessage'),
    toastAction: $('#toastAction'),
  };

  let state = loadState();
  let syncReady = false;
  let syncTimer = null;
  let syncing = false;
  let pendingSync = false;
  let localDirty = false;
  let syncError = false;
  let weekStart = startOfWeek(new Date());
  let editingMeal = null;
  let editingWishId = null;
  let editingPantryId = null;
  let toastTimer = null;
  let toastActionHandler = null;
  let mealSource = null;
  let mealPress = null;
  let mealDrag = null;
  let lastDropTarget = null;
  let suppressMealClick = false;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ESCAPE_MAP[character]);
  }

  function clampText(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
  }

  function normalizePrice(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(Math.min(parsed, 999999.99) * 100) / 100;
  }

  function formatPrice(value) {
    const price = normalizePrice(value);
    if (price === null) return '';
    return price.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function dateFromKey(key) {
    const [year, month, day] = String(key).split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  function isValidDateKey(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) return false;
    const date = dateFromKey(key);
    return !Number.isNaN(date.getTime()) && dateKey(date) === key;
  }

  function startOfWeek(input) {
    const date = new Date(input);
    date.setHours(12, 0, 0, 0);
    const day = date.getDay();
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
    return date;
  }

  function addDays(input, amount) {
    const date = new Date(input);
    date.setDate(date.getDate() + amount);
    return date;
  }

  function getWeekDays(start = weekStart) {
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }

  function isSameDay(first, second) {
    return dateKey(first) === dateKey(second);
  }

  function isCurrentWeek() {
    return dateKey(weekStart) === dateKey(startOfWeek(new Date()));
  }

  function isoWeekNumber(input) {
    const date = new Date(Date.UTC(input.getFullYear(), input.getMonth(), input.getDate()));
    const dayNumber = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  }

  function formatWeekRange(start, end) {
    if (start.getFullYear() !== end.getFullYear()) {
      return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 — ${end.getFullYear()}年${end.getMonth() + 1}月${end.getDate()}日`;
    }
    if (start.getMonth() !== end.getMonth()) {
      return `${start.getMonth() + 1}月${start.getDate()}日 — ${end.getMonth() + 1}月${end.getDate()}日`;
    }
    return `${start.getMonth() + 1}月${start.getDate()}日 — ${end.getDate()}日`;
  }

  function createEmptyState() {
    return {
      app: APP_ID,
      version: 3,
      meals: {},
      wishlist: [],
      pantry: [],
      updatedAt: null,
    };
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function safeId(value) {
    const candidate = String(value ?? '');
    return /^[a-zA-Z0-9_-]{6,80}$/.test(candidate) ? candidate : makeId();
  }

  function safeIsoDate(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }

  function normalizeMeal(value) {
    if (!value) return null;
    const title = clampText(typeof value === 'string' ? value : value.title, 80);
    if (!title) return null;
    const id = typeof value === 'object' ? safeId(value.id) : makeId();
    const note = typeof value === 'object' ? clampText(value.note, 160) : '';
    const cost = typeof value === 'object' ? normalizePrice(value.cost) : null;
    return { id, title, note, cost };
  }

  function normalizeDayMeals(day) {
    if (typeof day === 'string') return [normalizeMeal(day)].filter(Boolean);
    if (Array.isArray(day)) return day.map(normalizeMeal).filter(Boolean);
    if (!day || typeof day !== 'object') return [];

    const singleMeal = normalizeMeal({ id: day.id, title: day.title, note: day.note, cost: day.cost });
    if (singleMeal) return [singleMeal];

    return LEGACY_SLOTS.map((slot) => normalizeMeal(day[slot.key])).filter(Boolean);
  }

  function normalizeState(raw) {
    const normalized = createEmptyState();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return normalized;

    if (raw.meals && typeof raw.meals === 'object' && !Array.isArray(raw.meals)) {
      Object.entries(raw.meals).slice(0, 1200).forEach(([key, day]) => {
        if (!isValidDateKey(key) || !day || typeof day !== 'object') return;
        const meals = normalizeDayMeals(day);
        if (meals.length) normalized.meals[key] = meals;
      });
    }

    if (Array.isArray(raw.wishlist)) {
      normalized.wishlist = raw.wishlist
        .slice(0, 300)
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const name = clampText(item.name ?? item.title, 80);
          if (!name) return null;
          return {
            id: safeId(item.id),
            name,
            price: normalizePrice(item.price),
            note: clampText(item.note, 160),
            createdAt: safeIsoDate(item.createdAt),
          };
        })
        .filter(Boolean);
    }

    if (Array.isArray(raw.pantry)) {
      normalized.pantry = raw.pantry
        .slice(0, 300)
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const name = clampText(item.name ?? item.title, 80);
          if (!name) return null;
          const expiry = isValidDateKey(item.expiry) ? item.expiry : '';
          return {
            id: safeId(item.id),
            name,
            amount: clampText(item.amount, 30),
            price: normalizePrice(item.price),
            expiry,
            note: clampText(item.note, 160),
            createdAt: safeIsoDate(item.createdAt),
          };
        })
        .filter(Boolean);
    }

    if (typeof raw.updatedAt === 'string' && !Number.isNaN(new Date(raw.updatedAt).getTime())) {
      normalized.updatedAt = new Date(raw.updatedAt).toISOString();
    }

    return normalized;
  }

  function loadState() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return stored ? normalizeState(JSON.parse(stored)) : createEmptyState();
    } catch (error) {
      return createEmptyState();
    }
  }

  function persist(options = {}) {
    state.updatedAt = new Date().toISOString();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localDirty = true;
      syncError = false;
      setSaveStatus(false, syncReady ? '待同步' : '同步中');
      renderLastSaved();
      queueRemoteSave();
      return true;
    } catch (error) {
      setSaveStatus(true, '没有存上');
      if (!options.quiet) {
        showToast('浏览器没允许保存，建议用 start.bat 打开。');
      }
      return false;
    }
  }

  function setSaveStatus(warning, label) {
    dom.saveStatus.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${escapeHtml(label)}`;
    dom.saveStatus.classList.toggle('is-warning', warning);
  }

  function renderLastSaved() {
    if (!state.updatedAt) {
      dom.lastSaved.textContent = '正在和小账本同步';
      return;
    }
    const savedAt = new Date(state.updatedAt);
    const time = savedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    dom.lastSaved.textContent = syncError
      ? '暂时连不上，数据先存在本机'
      : localDirty
        ? `正在同步到小账本 · ${time} 更新`
        : `已同步到小账本 · ${time} 更新`;
  }

  function hasLocalData() {
    return Object.keys(state.meals || {}).length > 0 || state.wishlist.length > 0 || state.pantry.length > 0;
  }

  function redirectToLogin() {
    if (EMBEDDED) {
      notifyParent({ type: 'fanzhuo:auth' });
      return;
    }
    const next = window.location.pathname + window.location.search;
    window.location.replace('/?next=' + encodeURIComponent(next));
  }

  function queueRemoteSave() {
    if (!syncReady) return;
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(pushRemote, 650);
  }

  async function pushRemote() {
    if (!syncReady) return;
    if (syncing) {
      pendingSync = true;
      return;
    }
    syncing = true;
    setSaveStatus(false, '同步中');
    try {
      const response = await fetch('/api/fanzhuo', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: state, updatedAt: state.updatedAt }),
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      if (!response.ok) throw new Error('sync failed');
      localDirty = false;
      syncError = false;
      setSaveStatus(false, '已同步');
      renderLastSaved();
    } catch (error) {
      syncError = true;
      setSaveStatus(true, '待同步');
      renderLastSaved();
    } finally {
      syncing = false;
      if (pendingSync) {
        pendingSync = false;
        queueRemoteSave();
      }
    }
  }

  async function syncFromCloud() {
    try {
      const response = await fetch('/api/fanzhuo', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      if (!response.ok) throw new Error('sync failed');
      const payload = await response.json();
      const remote = payload?.data ? normalizeState(payload.data) : null;
      const localTime = state.updatedAt ? Date.parse(state.updatedAt) : 0;
      const remoteTime = remote?.updatedAt
        ? Date.parse(remote.updatedAt)
        : payload?.updatedAt
          ? Date.parse(payload.updatedAt)
          : 0;

      if (!localDirty && remote && remoteTime >= localTime) {
        state = remote;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        weekStart = startOfWeek(new Date());
        renderAll();
      }

      syncReady = true;
      syncError = false;
      if (localDirty || (!remote && hasLocalData()) || (remote && localTime > remoteTime)) {
        await pushRemote();
      } else {
        setSaveStatus(false, '已同步');
        renderLastSaved();
      }
    } catch (error) {
      syncReady = true;
      syncError = true;
      setSaveStatus(true, '待同步');
      renderLastSaved();
    }
  }

  function getMealCount() {
    return getWeekDays().reduce((total, day) => {
      return total + (state.meals[dateKey(day)] ? 1 : 0);
    }, 0);
  }

  function getMealTotalCount() {
    return getWeekDays().reduce((total, day) => {
      return total + (state.meals[dateKey(day)] || []).length;
    }, 0);
  }

  function getWeekCost() {
    return getWeekDays().reduce((total, day) => {
      return (
        total +
        (state.meals[dateKey(day)] || []).reduce((dayTotal, meal) => {
          return dayTotal + (Number.isFinite(meal.cost) ? meal.cost : 0);
        }, 0)
      );
    }, 0);
  }

  function getScheduledTitles() {
    const titles = new Set();
    getWeekDays().forEach((day) => {
      (state.meals[dateKey(day)] || []).forEach((meal) => {
        if (meal.title) titles.add(meal.title.trim());
      });
    });
    return titles;
  }

  function findMeal(date, id) {
    return (state.meals[date] || []).find((meal) => meal.id === id) || null;
  }

  function getExpiryInfo(expiry) {
    if (!isValidDateKey(expiry)) return { label: '', className: '', sort: Number.POSITIVE_INFINITY };
    const expiryDate = dateFromKey(expiry);
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const difference = Math.round((expiryDate - today) / 86400000);
    const labelDate = `${expiryDate.getMonth() + 1}月${expiryDate.getDate()}日`;

    if (difference < 0) return { label: '已过期', className: 'is-expired', sort: expiryDate.getTime() };
    if (difference === 0) return { label: '今天到期', className: 'is-soon', sort: expiryDate.getTime() };
    if (difference === 1) return { label: '明天到期', className: 'is-soon', sort: expiryDate.getTime() };
    if (difference <= 3) return { label: `${difference} 天后到期`, className: 'is-soon', sort: expiryDate.getTime() };
    return { label: `${labelDate}到期`, className: '', sort: expiryDate.getTime() };
  }

  function getAmountDecrement(amount) {
    const text = clampText(amount, 30);
    const match = text.match(/\d+(?:\.\d+)?/);
    if (!match) return null;

    const value = Number(match[0]);
    if (!Number.isFinite(value) || value <= 0) return null;

    const nextValue = Number((value - 1).toFixed(2));
    return {
      isLast: value <= 1,
      amount: `${text.slice(0, match.index)}${nextValue}${text.slice(match.index + match[0].length)}`,
    };
  }

  function blurActiveElement() {
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === 'function') active.blur();
  }

  function focusToday(options = {}) {
    const behavior = options.behavior === 'auto' ? 'auto' : 'smooth';
    const today = new Date();
    const todayKey = dateKey(today);
    if (!isCurrentWeek()) {
      weekStart = startOfWeek(today);
      renderAll();
    }
    window.requestAnimationFrame(() => {
      const card = dom.weekGrid.querySelector('[data-day-date="' + todayKey + '"]');
      if (!card) return;
      if (dom.weekGrid.scrollWidth <= dom.weekGrid.clientWidth + 2) return;
      const gridRect = dom.weekGrid.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      dom.weekGrid.scrollTo({
        left: dom.weekGrid.scrollLeft + cardRect.left - gridRect.left,
        behavior,
      });
    });
  }

  function consumeMealSource(source) {
    if (!source) return null;
    if (source.type === 'wishlist') {
      const index = state.wishlist.findIndex((item) => item.id === source.id);
      if (index < 0) return null;
      const [item] = state.wishlist.splice(index, 1);
      return { type: 'wishlist', index, item };
    }
    if (source.type === 'pantry') {
      const index = state.pantry.findIndex((item) => item.id === source.id);
      if (index < 0) return null;
      const item = state.pantry[index];
      const decrement = getAmountDecrement(item.amount);
      if (decrement && !decrement.isLast) {
        state.pantry[index] = { ...item, amount: decrement.amount };
        return { type: 'pantry', index, item: null };
      }
      state.pantry.splice(index, 1);
      return { type: 'pantry', index, item };
    }
    return null;
  }

  function getDropTarget(x, y) {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;
    const meal = element.closest('.meal-entry.has-meal[data-meal-date][data-meal-id]');
    if (meal) {
      const rect = meal.getBoundingClientRect();
      return {
        date: meal.dataset.mealDate,
        id: meal.dataset.mealId,
        after: y > rect.top + rect.height / 2,
        element: meal,
      };
    }
    const day = element.closest('[data-day-date]');
    if (day) return { date: day.dataset.dayDate, id: null, after: true, element: day };
    return null;
  }

  function beginMealPress(event) {
    if (mealDrag || event.isPrimary === false) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const button = event.target.closest('.meal-entry.has-meal[data-meal-date][data-meal-id]');
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const press = {
      pointerId: event.pointerId,
      date: button.dataset.mealDate,
      id: button.dataset.mealId,
      button,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      timer: 0,
    };
    press.timer = window.setTimeout(() => startMealDrag(press), 450);
    mealPress = press;
  }

  function startMealDrag(press) {
    if (mealPress !== press) return;
    if (!press.button.isConnected) {
      mealPress = null;
      return;
    }
    const rect = press.button.getBoundingClientRect();
    const clone = press.button.cloneNode(true);
    clone.classList.remove('is-drop-target');
    clone.classList.add('meal-drag-clone');
    clone.style.width = rect.width + 'px';
    clone.style.height = rect.height + 'px';
    clone.style.left = rect.left + 'px';
    clone.style.top = rect.top + 'px';
    document.body.appendChild(clone);
    press.button.classList.add('is-drag-source');
    document.body.classList.add('is-meal-dragging');
    mealDrag = { ...press, clone };
    lastDropTarget = null;
    suppressMealClick = true;
    window.clearTimeout(press.timer);
    if (navigator.vibrate) {
      try {
        navigator.vibrate(12);
      } catch (error) {}
    }
  }

  function updateDropTarget(x, y) {
    const target = getDropTarget(x, y);
    if (lastDropTarget && lastDropTarget.element !== (target && target.element)) {
      lastDropTarget.element.classList.remove('is-drop-target');
    }
    lastDropTarget = target;
    if (target && target.element) target.element.classList.add('is-drop-target');
  }

  function moveMealPress(event) {
    if (mealPress && !mealDrag) {
      const dx = event.clientX - mealPress.startX;
      const dy = event.clientY - mealPress.startY;
      if (Math.hypot(dx, dy) > 8) {
        window.clearTimeout(mealPress.timer);
        mealPress = null;
      }
    }
    if (!mealDrag || event.pointerId !== mealDrag.pointerId) return;
    if (event.cancelable) event.preventDefault();
    mealDrag.clone.style.left = event.clientX - mealDrag.offsetX + 'px';
    mealDrag.clone.style.top = event.clientY - mealDrag.offsetY + 'px';
    updateDropTarget(event.clientX, event.clientY);
  }

  function cleanupMealDrag() {
    if (mealDrag) {
      if (mealDrag.clone && mealDrag.clone.parentNode) mealDrag.clone.remove();
      if (mealDrag.button) mealDrag.button.classList.remove('is-drag-source');
    }
    if (lastDropTarget && lastDropTarget.element) {
      lastDropTarget.element.classList.remove('is-drop-target');
    }
    document.body.classList.remove('is-meal-dragging');
    mealDrag = null;
    lastDropTarget = null;
    window.setTimeout(() => {
      suppressMealClick = false;
    }, 500);
  }

  function reorderMeal(fromDate, mealId, target) {
    const source = state.meals[fromDate];
    if (!Array.isArray(source)) return;
    const fromIndex = source.findIndex((meal) => meal.id === mealId);
    if (fromIndex < 0) return;

    const targetList = state.meals[target.date] || [];
    let targetIndex = targetList.length;
    if (target.id) {
      const overIndex = targetList.findIndex((meal) => meal.id === target.id);
      if (overIndex >= 0) targetIndex = overIndex + (target.after ? 1 : 0);
    }
    if (fromDate === target.date) {
      if (target.id === mealId) return;
      if (targetIndex === fromIndex || targetIndex === fromIndex + 1) return;
    }

    const [meal] = source.splice(fromIndex, 1);
    if (fromDate === target.date && targetIndex > fromIndex) targetIndex -= 1;
    const destination = fromDate === target.date ? source : state.meals[target.date] || [];
    destination.splice(Math.max(0, Math.min(targetIndex, destination.length)), 0, meal);
    state.meals[target.date] = destination;
    if (fromDate !== target.date && source.length === 0) delete state.meals[fromDate];
    persist();
    renderAll();
    showToast('顺序已更新');
  }

  function finishMealPress(event) {
    if (mealPress && !mealDrag) {
      if (event.pointerId === mealPress.pointerId) {
        window.clearTimeout(mealPress.timer);
        mealPress = null;
      }
      return;
    }
    if (!mealDrag || event.pointerId !== mealDrag.pointerId) return;
    const target = lastDropTarget || getDropTarget(event.clientX, event.clientY);
    const fromDate = mealDrag.date;
    const mealId = mealDrag.id;
    cleanupMealDrag();
    if (!target) return;
    if (target.date === fromDate && target.id === mealId) return;
    reorderMeal(fromDate, mealId, target);
  }

  function cancelMealPress() {
    if (mealDrag) cleanupMealDrag();
    else if (mealPress) {
      window.clearTimeout(mealPress.timer);
      mealPress = null;
    }
  }

  function blockMealTouchScroll(event) {
    if (mealDrag && event.cancelable) event.preventDefault();
  }

  function renderAll() {
    renderWeek();
    renderWishlist();
    renderPantry();
    renderStats();
    renderLastSaved();
  }

  function renderWeek() {
    const weekNumber = isoWeekNumber(weekStart);
    const end = addDays(weekStart, 6);
    const today = new Date();
    const todayKey = dateKey(today);
    const currentWeek = isCurrentWeek();
    const days = getWeekDays();
    const mealDayCount = getMealCount();
    const mealTotalCount = getMealTotalCount();
    const weekCost = getWeekCost();

    dom.heroWeekLabel.textContent = `${weekStart.getFullYear()} · 第 ${weekNumber} 周`;
    dom.plateWeek.textContent = `WEEK ${pad2(weekNumber)}`;
    dom.weekRange.textContent = formatWeekRange(weekStart, end);
    dom.weekHint.textContent = `已排 ${mealTotalCount} 顿 · ${mealDayCount}/7 天`;
    dom.plannerTitle.textContent = currentWeek ? '本周菜单' : '这一周菜单';
    dom.todayButton.hidden = currentWeek;
    dom.weekPreviewTitle.textContent = currentWeek ? '本周预览' : '这一周预览';
    dom.weekPreviewRange.textContent = formatWeekRange(weekStart, end);
    dom.weekPreviewHint.textContent = mealTotalCount
      ? `已安排 ${mealTotalCount} 顿 · 预计 ¥${formatPrice(weekCost)}`
      : '这一周还空着，慢慢安排。';

    dom.weekPreview.innerHTML = days
      .map((day, index) => {
        const key = dateKey(day);
        const meals = state.meals[key] || [];
        const isToday = key === todayKey;
        const isPast = key < todayKey;
        const dayCost = meals.reduce((total, meal) => total + (Number.isFinite(meal.cost) ? meal.cost : 0), 0);
        const previewMeals = meals.length
          ? [
              ...meals.slice(0, 2).map((meal) => `<span class="preview-meal">${escapeHtml(meal.title)}</span>`),
              meals.length > 2 ? `<span class="preview-more">另 ${meals.length - 2} 顿</span>` : '',
            ].join('')
          : '<span class="preview-empty">还没安排</span>';
        const labelParts = [
          `${WEEKDAYS[day.getDay()]}，${day.getMonth() + 1}月${day.getDate()}日`,
          meals.length ? meals.map((meal) => meal.title).join('、') : '还没安排',
          dayCost > 0 ? `花费 ¥${formatPrice(dayCost)}` : '',
        ].filter(Boolean);
        const className = ['preview-day', isToday ? 'is-today' : '', isPast ? 'is-past' : '']
          .filter(Boolean)
          .join(' ');

        return `
          <article class="${className}" aria-label="${escapeHtml(labelParts.join('，'))}" style="animation-delay:${index * 30}ms">
            <div class="preview-day-head">
              <span class="preview-weekday">${WEEKDAYS[day.getDay()]}</span>
              <span class="preview-date">${day.getMonth() + 1}.${pad2(day.getDate())}</span>
              ${isToday ? '<span class="preview-today">今天</span>' : ''}
            </div>
            <div class="preview-meals">${previewMeals}</div>
            ${dayCost > 0 ? `<span class="preview-cost">¥${formatPrice(dayCost)}</span>` : ''}
          </article>
        `;
      })
      .join('');

    dom.weekGrid.innerHTML = days
      .map((day, index) => {
        const key = dateKey(day);
        const meals = state.meals[key] || [];
        const hasMeals = meals.length > 0;
        const isToday = key === todayKey;
        const isPast = key < todayKey;
        const isWeekend = day.getDay() === 0 || day.getDay() === 6;
        const className = ['day-card', isToday ? 'is-today' : '', isPast ? 'is-past' : '', isWeekend ? 'is-weekend' : '']
          .filter(Boolean)
          .join(' ');
        const mealsMarkup = meals
          .map((meal) => {
            const mealCost = Number.isFinite(meal.cost) ? `¥${formatPrice(meal.cost)}` : '';
            const label = `${WEEKDAYS[day.getDay()]}，${meal.title}${mealCost ? `，花费 ${mealCost}` : ''}`;
            return `
              <button
                class="meal-entry has-meal"
                type="button"
                data-meal-date="${key}"
                data-meal-id="${escapeHtml(meal.id)}"
                aria-label="${escapeHtml(`${label}，点击编辑`)}"
              >
                <span class="meal-entry-title">${escapeHtml(meal.title)}</span>
                ${meal.note ? `<span class="meal-entry-note">${escapeHtml(meal.note)}</span>` : ''}
                ${mealCost ? `<span class="meal-entry-cost">${mealCost}</span>` : ''}
              </button>
            `;
          })
          .join('');
        const mealMarkup = `
          <div class="day-meals">
            ${mealsMarkup}
            ${
              hasMeals
                ? `<button class="add-meal-entry" type="button" data-meal-date="${key}" aria-label="在${WEEKDAYS[day.getDay()]}再安排一顿">
                    <svg aria-hidden="true"><use href="#i-plus"></use></svg>
                    安排另一顿
                  </button>`
                : `<button class="meal-entry is-empty" type="button" data-meal-date="${key}" aria-label="在${WEEKDAYS[day.getDay()]}安排这顿">
                    <span class="meal-entry-empty">安排这顿</span>
                  </button>`
            }
          </div>
        `;

        return `
          <article class="${className}" data-day-date="${key}" style="animation-delay:${index * 34}ms">
            <div class="day-top">
              <span class="weekday">${WEEKDAYS[day.getDay()]}</span>
              <span class="day-date">${day.getMonth() + 1}.${pad2(day.getDate())}</span>
              ${isToday ? '<span class="today-pill">今天</span>' : ''}
            </div>
            <div class="day-meal">${mealMarkup}</div>
          </article>
        `;
      })
      .join('');
  }

  function renderStats() {
    dom.statMeals.textContent = String(getMealCount());
    dom.statWishes.textContent = String(state.wishlist.length);
    dom.statPantry.textContent = String(state.pantry.length);
    dom.statWeekCost.textContent = `¥${formatPrice(getWeekCost())}`;
  }

  function renderWishlist() {
    dom.wishCount.textContent = String(state.wishlist.length);
    dom.statWishes.textContent = String(state.wishlist.length);

    if (!state.wishlist.length) {
      dom.wishlist.innerHTML = `
        <div class="empty-state">
          <span class="empty-mark" aria-hidden="true">馋</span>
          <p>还没有记下想吃的东西。<br>想到什么就写什么。</p>
          <button type="button" data-empty-wish>记下第一道</button>
        </div>
      `;
      return;
    }

    const scheduled = getScheduledTitles();
    const items = state.wishlist
      .slice()
      .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));

    dom.wishlist.innerHTML = items
      .map((item) => {
        const isScheduled = scheduled.has(item.name.trim());
        const price = item.price === null ? '' : formatPrice(item.price);
        return `
          <article class="wish-item ${isScheduled ? 'is-scheduled' : ''}" data-wish-id="${escapeHtml(item.id)}">
            ${isScheduled ? '<div class="wish-top"><span class="planned-badge">已排入本周</span></div>' : ''}
            <div class="wish-title-row">
              <h3>${escapeHtml(item.name)}</h3>
              ${price ? `<span class="price-pill" title="价格">¥${price}</span>` : ''}
            </div>
            ${item.note ? `<p class="wish-note">${escapeHtml(item.note)}</p>` : ''}
            <div class="wish-actions">
              <button class="mini-button" type="button" data-wish-action="schedule" aria-label="把${escapeHtml(item.name)}排进菜单">
                <svg aria-hidden="true"><use href="#i-calendar-plus"></use></svg>
                排进菜单
              </button>
              <button class="row-action is-done" type="button" data-wish-action="done" title="吃到了" aria-label="标记${escapeHtml(item.name)}已经吃到">
                <svg aria-hidden="true"><use href="#i-check"></use></svg>
              </button>
              <button class="row-action" type="button" data-wish-action="edit" title="编辑" aria-label="编辑${escapeHtml(item.name)}">
                <svg aria-hidden="true"><use href="#i-pencil"></use></svg>
              </button>
            </div>
          </article>
        `;
      })
      .join('');
  }

  function renderPantry() {
    dom.pantryCount.textContent = String(state.pantry.length);
    dom.statPantry.textContent = String(state.pantry.length);

    if (!state.pantry.length) {
      dom.pantryList.innerHTML = `
        <div class="empty-state">
          <span class="empty-mark" aria-hidden="true">鲜</span>
          <p>手边还没有记下什么。<br>把冰箱里能吃的收进来。</p>
          <button type="button" data-empty-pantry>记一样手边的</button>
        </div>
      `;
      return;
    }

    const items = getSortedPantryItems();

    dom.pantryList.innerHTML = items
      .map((item) => {
        const expiry = getExpiryInfo(item.expiry);
        const decrement = getAmountDecrement(item.amount);
        const meta = expiry.label;
        const price = item.price === null ? '' : formatPrice(item.price);
        return `
          <div class="pantry-item" data-pantry-id="${escapeHtml(item.id)}">
            <span class="pantry-dot" aria-hidden="true"></span>
            <div class="pantry-copy">
              <div class="pantry-title">
                <span class="pantry-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                ${item.amount ? `<span class="amount-pill">${escapeHtml(item.amount)}</span>` : ''}
                ${price ? `<span class="price-pill" title="价格">¥${price}</span>` : ''}
              </div>
              ${
                meta
                  ? `<div class="pantry-meta ${expiry.className}" title="${escapeHtml(item.note || meta)}">${escapeHtml(meta)}</div>`
                  : ''
              }
            </div>
            <div class="pantry-actions">
              ${
                decrement
                  ? `<button class="row-action pantry-decrement" type="button" data-pantry-action="decrement" title="数量减一" aria-label="把${escapeHtml(item.name)}的数量减一">
                      <svg aria-hidden="true"><use href="#i-minus"></use></svg>
                    </button>`
                  : ''
              }
              <button class="row-action is-done" type="button" data-pantry-action="consume" title="用掉" aria-label="标记${escapeHtml(item.name)}已经用掉">
                <svg aria-hidden="true"><use href="#i-check"></use></svg>
              </button>
              <button class="row-action" type="button" data-pantry-action="edit" title="编辑" aria-label="编辑${escapeHtml(item.name)}">
                <svg aria-hidden="true"><use href="#i-pencil"></use></svg>
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function getSortedPantryItems() {
    return state.pantry.slice().sort((first, second) => {
      const firstExpiry = getExpiryInfo(first.expiry).sort;
      const secondExpiry = getExpiryInfo(second.expiry).sort;
      if (firstExpiry !== secondExpiry) return firstExpiry - secondExpiry;
      return new Date(second.createdAt) - new Date(first.createdAt);
    });
  }

  function populateMealDateOptions(selectedKey) {
    const todayKey = dateKey(new Date());
    const days = getWeekDays();
    dom.mealDate.innerHTML = days
      .map((day) => {
        const key = dateKey(day);
        const todaySuffix = key === todayKey ? ' · 今天' : '';
        return `<option value="${key}">${WEEKDAYS[day.getDay()]} · ${day.getMonth() + 1}月${day.getDate()}日${todaySuffix}</option>`;
      })
      .join('');
    dom.mealDate.value = days.some((day) => dateKey(day) === selectedKey) ? selectedKey : dateKey(weekStart);
  }

  function defaultMealDate() {
    const todayKey = dateKey(new Date());
    if (getWeekDays().some((day) => dateKey(day) === todayKey)) return todayKey;
    return dateKey(weekStart);
  }

  function renderMealSuggestions(show) {
    const wishSuggestions = state.wishlist.slice(0, 4);
    const pantrySuggestions = getSortedPantryItems();
    if (!show || (!wishSuggestions.length && !pantrySuggestions.length)) {
      dom.mealSuggestions.hidden = true;
      dom.mealSuggestions.innerHTML = '';
      return;
    }

    const wishGroup = wishSuggestions.length
      ? `
        <div class="suggestion-group">
          <span class="suggestion-label">从想吃的清单挑</span>
          <div class="suggestion-chips">
            ${wishSuggestions
              .map(
                (item) =>
                  `<button class="suggestion-chip" type="button" data-suggestion-id="${escapeHtml(item.id)}" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>`,
              )
              .join('')}
          </div>
        </div>
      `
      : '';
    const pantryGroup = pantrySuggestions.length
      ? `
        <div class="suggestion-group">
          <span class="suggestion-label">从柜子里挑</span>
          <div class="suggestion-chips">
            ${pantrySuggestions
              .map(
                (item) => `
                  <button
                    class="suggestion-chip is-pantry"
                    type="button"
                    data-pantry-suggestion-id="${escapeHtml(item.id)}"
                    title="${escapeHtml(`${item.name}${item.amount ? ` · ${item.amount}` : ''}`)}"
                  >${escapeHtml(item.name)}${item.amount ? `<small>${escapeHtml(item.amount)}</small>` : ''}</button>
                `,
              )
              .join('')}
          </div>
        </div>
      `
      : '';

    dom.mealSuggestions.hidden = false;
    dom.mealSuggestions.innerHTML = wishGroup + pantryGroup;
  }

  function openMealDialog(options = {}) {
    const date = isValidDateKey(options.date) ? options.date : defaultMealDate();
    const meal = options.mealId ? findMeal(date, options.mealId) : null;
    const prefillCost = normalizePrice(options.prefillCost);
    const dayHasMeals = (state.meals[date] || []).length > 0;

    editingMeal = meal ? { date, id: meal.id } : null;
    mealSource = !meal && options.source ? { type: options.source.type, id: options.source.id } : null;
    dom.mealTitle.value = meal ? meal.title : clampText(options.prefillTitle, 80);
    dom.mealCost.value =
      meal && Number.isFinite(meal.cost) ? String(meal.cost) : prefillCost === null ? '' : String(prefillCost);
    dom.mealNote.value = meal ? meal.note : clampText(options.prefillNote, 160);
    populateMealDateOptions(date);
    dom.mealError.hidden = true;
    dom.mealDialogTitle.textContent = meal ? '改一改这顿' : dayHasMeals ? '再安排一顿' : '安排这顿';
    dom.saveMealButton.textContent = meal ? '保存这顿' : '放进菜单';
    dom.mealRemoveActions.hidden = !meal;
    renderMealSuggestions(!meal);
    openDialog(dom.mealDialog);
    if (!COARSE_POINTER) window.setTimeout(() => dom.mealTitle.focus(), 35);
  }

  function removeMeal(reference) {
    if (!reference) return null;
    const meals = state.meals[reference.date];
    if (!Array.isArray(meals)) return null;
    const index = meals.findIndex((meal) => meal.id === reference.id);
    if (index < 0) return null;
    const [meal] = meals.splice(index, 1);
    if (meals.length) state.meals[reference.date] = meals;
    else delete state.meals[reference.date];
    return { meal, index };
  }

  function handleMealSubmit(event) {
    event.preventDefault();
    const title = clampText(dom.mealTitle.value, 80);
    if (!title) {
      dom.mealError.hidden = false;
      dom.mealTitle.focus();
      return;
    }

    const note = clampText(dom.mealNote.value, 160);
    const cost = normalizePrice(dom.mealCost.value);
    const targetDate = isValidDateKey(dom.mealDate.value) ? dom.mealDate.value : defaultMealDate();
    const wasEditing = Boolean(editingMeal);
    const existing = editingMeal ? findMeal(editingMeal.date, editingMeal.id) : null;
    const consumed = wasEditing ? null : consumeMealSource(mealSource);
    const item = {
      id: existing ? existing.id : makeId(),
      title,
      note,
      cost,
    };

    if (editingMeal && editingMeal.date !== targetDate) {
      removeMeal(editingMeal);
    }

    const targetMeals = state.meals[targetDate] || [];
    const existingIndex = existing && editingMeal.date === targetDate
      ? targetMeals.findIndex((meal) => meal.id === existing.id)
      : -1;
    if (existingIndex >= 0) targetMeals[existingIndex] = item;
    else targetMeals.push(item);
    state.meals[targetDate] = targetMeals;
    persist();
    renderAll();
    dom.mealDialog.close();
    mealSource = null;
    const consumedHint = consumed
      ? consumed.type === 'wishlist'
        ? '，已从清单去掉'
        : '，柜子已扣掉一份'
      : '';
    showToast(wasEditing ? `已更新：${title}` : `已放进菜单：${title}${consumedHint}`);
  }

  function deleteCurrentMeal() {
    if (!editingMeal) return;
    const reference = { date: editingMeal.date, id: editingMeal.id };
    const removed = removeMeal(reference);
    if (!removed) return;

    persist();
    renderAll();
    dom.mealDialog.close();
    showToast('已删掉这顿', () => {
      const meals = state.meals[reference.date] || [];
      meals.splice(Math.min(removed.index, meals.length), 0, removed.meal);
      state.meals[reference.date] = meals;
      persist();
      renderAll();
    });
  }

  function moveDeletedMeal(target) {
    if (!editingMeal) return;
    const reference = { date: editingMeal.date, id: editingMeal.id };
    const sourceMeal = findMeal(reference.date, reference.id);
    if (!sourceMeal) return;

    const title = clampText(dom.mealTitle.value, 80) || sourceMeal.title;
    const note = clampText(dom.mealNote.value, 160);
    const price = normalizePrice(dom.mealCost.value);
    const removed = removeMeal(reference);
    if (!removed) return;

    const createdAt = new Date().toISOString();
    let created;
    let label;
    if (target === 'wishlist') {
      created = { id: makeId(), name: title, price, note, createdAt };
      state.wishlist.unshift(created);
      label = '想吃清单';
    } else {
      created = { id: makeId(), name: title, amount: '', price, expiry: '', note, createdAt };
      state.pantry.unshift(created);
      label = '柜子';
    }

    persist();
    renderAll();
    dom.mealDialog.close();
    showToast(`已移到${label}：${title}`, () => {
      if (target === 'wishlist') {
        state.wishlist = state.wishlist.filter((item) => item.id !== created.id);
      } else {
        state.pantry = state.pantry.filter((item) => item.id !== created.id);
      }
      const meals = state.meals[reference.date] || [];
      meals.splice(Math.min(removed.index, meals.length), 0, removed.meal);
      state.meals[reference.date] = meals;
      persist();
      renderAll();
    });
  }

  function findWish(id) {
    return state.wishlist.find((item) => item.id === id) || null;
  }

  function openWishDialog(id = null) {
    const item = id ? findWish(id) : null;
    editingWishId = item ? item.id : null;
    dom.wishName.value = item ? item.name : '';
    dom.wishPrice.value = item && item.price !== null ? String(item.price) : '';
    dom.wishNote.value = item ? item.note : '';
    dom.wishError.hidden = true;
    dom.wishDialogTitle.textContent = item ? '改一改想吃的' : '记下想吃的';
    dom.saveWishButton.textContent = item ? '保存' : '记下来';
    dom.deleteWishButton.hidden = !item;
    openDialog(dom.wishDialog);
    window.setTimeout(() => dom.wishName.focus(), 35);
  }

  function handleWishSubmit(event) {
    event.preventDefault();
    const name = clampText(dom.wishName.value, 80);
    if (!name) {
      dom.wishError.hidden = false;
      dom.wishName.focus();
      return;
    }

    const existing = editingWishId ? findWish(editingWishId) : null;
    const item = {
      id: existing ? existing.id : makeId(),
      name,
      price: normalizePrice(dom.wishPrice.value),
      note: clampText(dom.wishNote.value, 160),
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
    };

    if (existing) {
      state.wishlist = state.wishlist.map((entry) => (entry.id === existing.id ? item : entry));
    } else {
      state.wishlist.unshift(item);
    }

    persist();
    renderAll();
    dom.wishDialog.close();
    showToast(existing ? `已更新：${name}` : `记下了：${name}`);
  }

  function deleteWish(id) {
    const index = state.wishlist.findIndex((item) => item.id === id);
    if (index < 0) return;
    const item = state.wishlist[index];
    state.wishlist.splice(index, 1);
    persist();
    renderAll();
    dom.wishDialog.close();
    showToast(`已删除：${item.name}`, () => {
      state.wishlist.splice(Math.min(index, state.wishlist.length), 0, item);
      persist();
      renderAll();
    });
  }

  function scheduleWish(id) {
    const item = findWish(id);
    if (!item) return;
    openMealDialog({
      date: defaultMealDate(),
      prefillTitle: item.name,
      prefillNote: item.note,
      prefillCost: item.price,
      source: { type: 'wishlist', id: item.id },
    });
  }

  function finishWish(id) {
    const index = state.wishlist.findIndex((item) => item.id === id);
    if (index < 0) return;
    const item = state.wishlist[index];
    state.wishlist.splice(index, 1);
    persist();
    renderAll();
    showToast(`吃到了：${item.name}`, () => {
      state.wishlist.splice(Math.min(index, state.wishlist.length), 0, item);
      persist();
      renderAll();
    });
  }

  function findPantry(id) {
    return state.pantry.find((item) => item.id === id) || null;
  }

  function openPantryDialog(id = null) {
    const item = id ? findPantry(id) : null;
    editingPantryId = item ? item.id : null;
    dom.pantryName.value = item ? item.name : '';
    dom.pantryAmount.value = item ? item.amount : '';
    dom.pantryPrice.value = item && item.price !== null ? String(item.price) : '';
    dom.pantryExpiry.value = item ? item.expiry : '';
    dom.pantryNote.value = item ? item.note : '';
    dom.pantryError.hidden = true;
    dom.pantryDialogTitle.textContent = item ? '改一改手边的' : '记一样手边的';
    dom.savePantryButton.textContent = item ? '保存' : '收进清单';
    dom.deletePantryButton.hidden = !item;
    openDialog(dom.pantryDialog);
    window.setTimeout(() => dom.pantryName.focus(), 35);
  }

  function handlePantrySubmit(event) {
    event.preventDefault();
    const name = clampText(dom.pantryName.value, 80);
    if (!name) {
      dom.pantryError.hidden = false;
      dom.pantryName.focus();
      return;
    }

    const existing = editingPantryId ? findPantry(editingPantryId) : null;
    const item = {
      id: existing ? existing.id : makeId(),
      name,
      amount: clampText(dom.pantryAmount.value, 30),
      price: normalizePrice(dom.pantryPrice.value),
      expiry: isValidDateKey(dom.pantryExpiry.value) ? dom.pantryExpiry.value : '',
      note: clampText(dom.pantryNote.value, 160),
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
    };

    if (existing) {
      state.pantry = state.pantry.map((entry) => (entry.id === existing.id ? item : entry));
    } else {
      state.pantry.unshift(item);
    }

    persist();
    renderAll();
    dom.pantryDialog.close();
    showToast(existing ? `已更新：${name}` : `收好了：${name}`);
  }

  function deletePantry(id) {
    const index = state.pantry.findIndex((item) => item.id === id);
    if (index < 0) return;
    const item = state.pantry[index];
    state.pantry.splice(index, 1);
    persist();
    renderAll();
    dom.pantryDialog.close();
    showToast(`已删除：${item.name}`, () => {
      state.pantry.splice(Math.min(index, state.pantry.length), 0, item);
      persist();
      renderAll();
    });
  }

  function consumePantry(id) {
    const index = state.pantry.findIndex((item) => item.id === id);
    if (index < 0) return;
    const item = state.pantry[index];
    state.pantry.splice(index, 1);
    persist();
    renderAll();
    showToast(`用掉了：${item.name}`, () => {
      state.pantry.splice(Math.min(index, state.pantry.length), 0, item);
      persist();
      renderAll();
    });
  }

  function decrementPantry(id) {
    const index = state.pantry.findIndex((item) => item.id === id);
    if (index < 0) return;
    const item = state.pantry[index];
    const decrement = getAmountDecrement(item.amount);
    if (!decrement) return;

    if (decrement.isLast) {
      consumePantry(id);
      return;
    }

    const previousAmount = item.amount;
    state.pantry = state.pantry.map((entry) =>
      entry.id === id ? { ...entry, amount: decrement.amount } : entry,
    );
    persist();
    renderAll();
    showToast(`${item.name} 还剩 ${decrement.amount}`, () => {
      state.pantry = state.pantry.map((entry) =>
        entry.id === id ? { ...entry, amount: previousAmount } : entry,
      );
      persist();
      renderAll();
    });
  }

  function openDialog(dialog) {
    if (!dialog.open) {
      dialog.showModal();
      notifyParent({ type: 'fanzhuo:modal', open: true });
    }
  }

  function hideToast() {
    window.clearTimeout(toastTimer);
    dom.toast.classList.remove('is-visible');
    toastActionHandler = null;
    dom.toastAction.hidden = true;
  }

  function showToast(message, actionHandler = null) {
    window.clearTimeout(toastTimer);
    dom.toastMessage.textContent = message;
    toastActionHandler = actionHandler;
    dom.toastAction.hidden = !actionHandler;
    dom.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(hideToast, actionHandler ? 6500 : 3300);
  }

  function changeWeek(amount) {
    weekStart = addDays(weekStart, amount);
    renderAll();
    dom.weekGrid.scrollLeft = 0;
  }

  function exportData() {
    const payload = {
      ...state,
      app: APP_ID,
      version: 2,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fanzhuo-backup-${dateKey(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('备份已经导出。');
  }

  async function importData(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const looksLikeBackup =
        parsed && typeof parsed === 'object' && (parsed.app === APP_ID || 'meals' in parsed || 'wishlist' in parsed || 'pantry' in parsed);
      if (!looksLikeBackup) throw new Error('Invalid backup');
      if (!window.confirm('导入会替换现在所有的菜单和清单，确定继续吗？')) return;

      state = normalizeState(parsed);
      weekStart = startOfWeek(new Date());
      persist({ quiet: true });
      renderAll();
      showToast('备份已导入。');
    } catch (error) {
      showToast('导入失败：这个文件看起来不是饭桌备份。');
    } finally {
      dom.importInput.value = '';
    }
  }

  function testLocalStorage() {
    try {
      const key = `${STORAGE_KEY}.test`;
      window.localStorage.setItem(key, '1');
      window.localStorage.removeItem(key);
      return true;
    } catch (error) {
      return false;
    }
  }

  function bindEvents() {
    dom.prevWeekButton.addEventListener('click', () => changeWeek(-7));
    dom.nextWeekButton.addEventListener('click', () => changeWeek(7));
    dom.todayButton.addEventListener('click', () => {
      weekStart = startOfWeek(new Date());
      renderAll();
    });
    dom.brandButton.addEventListener('click', (event) => {
      event.preventDefault();
      weekStart = startOfWeek(new Date());
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    if (dom.ledgerHomeLink) {
      dom.ledgerHomeLink.addEventListener('click', (event) => {
        if (!EMBEDDED) return;
        event.preventDefault();
        notifyParent({ type: 'fanzhuo:navigate', view: 'entry' });
      });
    }

    dom.weekGrid.addEventListener('click', (event) => {
      if (suppressMealClick) {
        suppressMealClick = false;
        event.preventDefault();
        return;
      }
      const button = event.target.closest('[data-meal-date]');
      if (!button) return;
      const date = button.dataset.mealDate;
      const mealId = button.dataset.mealId || null;
      openMealDialog({ date, mealId });
    });

    dom.weekGrid.addEventListener('pointerdown', beginMealPress);
    document.addEventListener('pointermove', moveMealPress, { passive: false });
    document.addEventListener('pointerup', finishMealPress);
    document.addEventListener('pointercancel', cancelMealPress);
    document.addEventListener('touchmove', blockMealTouchScroll, { passive: false });

    dom.addWishButton.addEventListener('click', () => openWishDialog());
    dom.addPantryButton.addEventListener('click', () => openPantryDialog());

    dom.wishlist.addEventListener('click', (event) => {
      if (event.target.closest('[data-empty-wish]')) {
        openWishDialog();
        return;
      }
      const actionButton = event.target.closest('[data-wish-action]');
      if (!actionButton) return;
      const item = actionButton.closest('[data-wish-id]');
      if (!item) return;
      const id = item.dataset.wishId;
      const action = actionButton.dataset.wishAction;
      if (action === 'schedule') scheduleWish(id);
      if (action === 'done') finishWish(id);
      if (action === 'edit') openWishDialog(id);
    });

    dom.pantryList.addEventListener('click', (event) => {
      if (event.target.closest('[data-empty-pantry]')) {
        openPantryDialog();
        return;
      }
      const actionButton = event.target.closest('[data-pantry-action]');
      if (!actionButton) return;
      const item = actionButton.closest('[data-pantry-id]');
      if (!item) return;
      const id = item.dataset.pantryId;
      const action = actionButton.dataset.pantryAction;
      if (action === 'edit') openPantryDialog(id);
      if (action === 'consume') consumePantry(id);
      if (action === 'decrement') decrementPantry(id);
    });

    dom.mealForm.addEventListener('submit', handleMealSubmit);
    dom.wishForm.addEventListener('submit', handleWishSubmit);
    dom.pantryForm.addEventListener('submit', handlePantrySubmit);
    dom.deleteMealButton.addEventListener('click', deleteCurrentMeal);
    dom.deleteMealToWishButton.addEventListener('click', () => moveDeletedMeal('wishlist'));
    dom.deleteMealToPantryButton.addEventListener('click', () => moveDeletedMeal('pantry'));
    dom.deleteWishButton.addEventListener('click', () => {
      if (editingWishId) deleteWish(editingWishId);
    });
    dom.deletePantryButton.addEventListener('click', () => {
      if (editingPantryId) deletePantry(editingPantryId);
    });

    dom.mealTitle.addEventListener('input', () => {
      dom.mealError.hidden = true;
    });
    dom.wishName.addEventListener('input', () => {
      dom.wishError.hidden = true;
    });
    dom.pantryName.addEventListener('input', () => {
      dom.pantryError.hidden = true;
    });

    dom.mealSuggestions.addEventListener('click', (event) => {
      const pantryButton = event.target.closest('[data-pantry-suggestion-id]');
      if (pantryButton) {
        const item = findPantry(pantryButton.dataset.pantrySuggestionId);
        if (!item) return;
        dom.mealTitle.value = item.name;
        if (item.note) dom.mealNote.value = item.note;
        if (item.price !== null) dom.mealCost.value = String(item.price);
        mealSource = { type: 'pantry', id: item.id };
        blurActiveElement();
        return;
      }

      const button = event.target.closest('[data-suggestion-id]');
      if (!button) return;
      const item = findWish(button.dataset.suggestionId);
      if (!item) return;
      dom.mealTitle.value = item.name;
      if (item.note) dom.mealNote.value = item.note;
      if (item.price !== null) dom.mealCost.value = String(item.price);
      mealSource = { type: 'wishlist', id: item.id };
      blurActiveElement();
    });

    $$('[data-close]').forEach((button) => {
      button.addEventListener('click', () => button.closest('dialog')?.close());
    });

    [dom.mealDialog, dom.wishDialog, dom.pantryDialog].forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener('close', () => {
        editingMeal = null;
        editingWishId = null;
        editingPantryId = null;
        mealSource = null;
        notifyParent({ type: 'fanzhuo:modal', open: false });
      });
    });

    dom.exportButton.addEventListener('click', exportData);
    dom.importButton.addEventListener('click', () => dom.importInput.click());
    dom.importInput.addEventListener('change', () => {
      const file = dom.importInput.files && dom.importInput.files[0];
      if (file) importData(file);
    });

    dom.toastAction.addEventListener('click', () => {
      const action = toastActionHandler;
      hideToast();
      if (action) action();
    });
  }

  function init() {
    bindEvents();
    renderAll();
    if (!testLocalStorage()) {
      setSaveStatus(true, '临时模式');
      window.setTimeout(() => showToast('浏览器不允许本地保存，数据仍会同步到小账本。'), 900);
    }
    window.addEventListener('online', () => {
      if (syncReady && (localDirty || syncError)) queueRemoteSave();
    });
    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin || !event.data) return;
      if (event.data.type === 'fanzhuo:showToday') focusToday({ behavior: 'smooth' });
    });
    window.setTimeout(() => focusToday({ behavior: 'auto' }), 80);
    syncFromCloud().finally(() => focusToday({ behavior: 'auto' }));
  }

  init();
})();

