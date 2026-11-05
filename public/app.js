const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

const state = {
  view: "entry",
  month: ym(new Date()),
  categories: [],
  bills: [],
  stats: null,
  savings: null,
  savingsMode: "in",
  savingsDir: "in",
  total: { n: 0, minDate: null, maxDate: null },
  form: { type: 1, amount: "", category_id: null, subcategory_id: null, date: todayStr() },
  editing: null,
  searching: "",
  selecting: false,
  selected: new Set(),
  batchType: 1,
  me: null,
};

function pad(n) { return String(n).padStart(2, "0"); }
function ym(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
function todayStr() { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function nowTime() { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function fmtMonth(m) { const [y, mo] = m.split("-"); return y + "年" + Number(mo) + "月"; }
function fmtDateLabel(s, withYear = false) {
  const d = new Date(s + "T00:00:00");
  const w = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return (withYear ? d.getFullYear() + "年" : "") + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + w;
}
function fmtMoney(cents) {
  return (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

async function api(path, opts = {}) {
  const init = { credentials: "same-origin", ...opts };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers = { "content-type": "application/json", ...(init.headers || {}) };
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    showLogin();
    throw new Error("未登录");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

/* ---------- 登录 ---------- */
function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  state.me = null;
  const frame = $("#fanzhuo-frame");
  if (frame) {
    frame.setAttribute("src", "about:blank");
  }
  try { localStorage.removeItem("fanzhuo.data.v1"); } catch {}
  const username = $("#username");
  if (username && !username.value) {
    try { username.value = localStorage.getItem("mm.lastUser") || ""; } catch {}
  }
  setTimeout(() => $(username && username.value ? "#password" : "#username").focus(), 50);
}

function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  $("#login-error").textContent = "";
  try {
    const username = $("#username").value.trim();
    await api("/api/login", {
      method: "POST",
      body: { username, password: $("#password").value },
    });
    try { localStorage.setItem("mm.lastUser", username); } catch {}
    const next = new URLSearchParams(location.search).get("next");
    location.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
  } catch (err) {
    $("#login-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 启动 ---------- */
async function boot() {
  const data = await api("/api/bootstrap?month=" + state.month);
  state.categories = data.categories || [];
  state.total = data.total || state.total;
  state.me = data.user || null;
  $("#top-meta").textContent = state.total.n ? "共 " + state.total.n + " 笔" : "";
  initEntry();
  const want = new URLSearchParams(location.search).get("view");
  switchView(["entry", "list", "stats", "fanzhuo", "me"].includes(want) ? want : "entry");
  refreshVisible();
}

function initEntry() {
  if (!state.form.category_id) pickDefaultCategory();
  $("#date").value = state.form.date;
  $("#amount").value = state.form.amount;
  renderCats();
}

function pickDefaultCategory() {
  const list = state.categories.filter((c) => c.type === state.form.type && !c.hidden && c.parent_id == null);
  state.form.category_id = list.length ? list[0].id : null;
  state.form.subcategory_id = null;
}

function renderCats() {
  const list = state.categories.filter((c) => c.type === state.form.type && !c.hidden && c.parent_id == null);
  if (state.form.category_id && !list.some((c) => c.id === state.form.category_id)) pickDefaultCategory();
  $("#cat-grid").innerHTML = list.map((c) => `
    <button type="button" class="cat ${c.id === state.form.category_id ? "active" : ""}" data-id="${c.id}">
      <span class="emoji">${esc(c.emoji)}</span>
      <span class="name">${esc(c.name)}</span>
    </button>`).join("") || `<div class="empty">还没有分类，去「我的 → 分类管理」添加</div>`;
  renderSubcats();
}

function renderSubcats() {
  const row = $("#subcat-row");
  if (!state.form.category_id) {
    row.classList.add("hidden");
    row.innerHTML = "";
    return;
  }
  const kids = state.categories.filter((c) => c.parent_id === state.form.category_id && !c.hidden);
  row.classList.remove("hidden");
  row.innerHTML = `<button type="button" class="subcat ${state.form.subcategory_id == null ? "active" : ""}" data-sid="">全部</button>` +
    kids.map((c) => `<button type="button" class="subcat ${c.id === state.form.subcategory_id ? "active" : ""}" data-sid="${c.id}">${esc(c.name)}</button>`).join("") +
    `<button type="button" class="subcat-add" id="subcat-add" title="添加子类">＋</button>`;
}

$("#cat-grid").addEventListener("click", (e) => {
  const btn = e.target.closest(".cat");
  if (!btn) return;
  state.form.category_id = Number(btn.dataset.id);
  state.form.subcategory_id = null;
  renderCats();
});

$("#subcat-row").addEventListener("click", (e) => {
  if (e.target.closest("#subcat-add")) {
    openAddSub();
    return;
  }
  const btn = e.target.closest(".subcat");
  if (!btn) return;
  state.form.subcategory_id = btn.dataset.sid ? Number(btn.dataset.sid) : null;
  renderSubcats();
});

function openAddSub() {
  const cat = state.categories.find((c) => c.id === state.form.category_id);
  if (!cat) return;
  $("#sub-parent-hint").textContent = "加在「" + cat.name + "」下面";
  $("#sub-name").value = "";
  $("#sub-emoji").value = cat.emoji || "📌";
  $("#sheet-sub").classList.remove("hidden");
  setTimeout(() => $("#sub-name").focus(), 100);
}

$("#sub-save").addEventListener("click", async () => {
  const name = $("#sub-name").value.trim();
  if (!name) return toast("填个子类名");
  try {
    const res = await api("/api/categories", {
      method: "POST",
      body: {
        name,
        type: state.form.type,
        emoji: $("#sub-emoji").value.trim() || "📌",
        parent_id: state.form.category_id,
      },
    });
    await reloadCategories();
    state.form.subcategory_id = res.id;
    renderCats();
    closeSheets();
    toast("已添加子类");
  } catch (err) {
    toast(err.message);
  }
});

$("#type-seg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-type]");
  if (!btn) return;
  state.form.type = Number(btn.dataset.type);
  pickDefaultCategory();
  $$("#type-seg button").forEach((b) => b.classList.toggle("active", b === btn));
  renderCats();
});

$("#amount").addEventListener("input", (e) => {
  let v = e.target.value.replace(/[^\d.]/g, "");
  const i = v.indexOf(".");
  if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, "").slice(0, 2);
  e.target.value = v;
  state.form.amount = v;
});

$("#date").addEventListener("change", (e) => { state.form.date = e.target.value || todayStr(); });

$("#btn-save").addEventListener("click", async () => {
  const amount = parseFloat(state.form.amount);
  if (!state.form.amount || !(amount > 0)) return toast("先输入金额");
  if (!state.form.category_id) return toast("选一个分类");
  const btn = $("#btn-save");
  btn.disabled = true;
  try {
    await api("/api/bills", {
      method: "POST",
      body: {
        type: state.form.type,
        amount: state.form.amount,
        category_id: state.form.category_id,
        subcategory_id: state.form.subcategory_id,
        date: state.form.date,
        time: nowTime(),
      },
    });
    state.form.amount = "";
    $("#amount").value = "";
    state.total.n += 1;
    $("#top-meta").textContent = "共 " + state.total.n + " 笔";
    toast("已记一笔");
    if (state.view === "list") await loadBills();
    if (state.view === "stats") await loadStats();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 明细 ---------- */
async function loadBills() {
  if (state.selecting) setSelectMode(false);
  const q = state.searching ? "&q=" + encodeURIComponent(state.searching) + "&scope=all" : "";
  const data = await api("/api/bills?month=" + state.month + q);
  state.bills = data.bills || [];
  renderBills();
}

function renderBills() {
  const searching = !!state.searching;
  $("#month-label").textContent = searching ? "全部账单 · " + state.bills.length + " 笔" : fmtMonth(state.month);
  $("#prev-month").style.visibility = searching ? "hidden" : "";
  $("#next-month").style.visibility = searching ? "hidden" : "";
  $("#btn-select").disabled = !state.bills.length && !state.selecting;
  const expense = state.bills.filter((b) => b.type === 1).reduce((sum, b) => sum + b.amount_cents, 0);
  const income = state.bills.filter((b) => b.type === 2).reduce((sum, b) => sum + b.amount_cents, 0);
  $("#list-summary").innerHTML = `
    <div class="sum"><div class="k">支出</div><div class="v">¥${fmtMoney(expense)}</div></div>
    <div class="sum"><div class="k">收入</div><div class="v green">¥${fmtMoney(income)}</div></div>
    <div class="sum"><div class="k">结余</div><div class="v">¥${fmtMoney(income - expense)}</div></div>`;

  if (!state.bills.length) {
    $("#bill-list").innerHTML = `<div class="empty">` + (searching ? "没有找到匹配的账单" : "这个月还没有账单") + `</div>`;
    updateBatchBar();
    return;
  }
  const groups = new Map();
  for (const b of state.bills) {
    if (!groups.has(b.date)) groups.set(b.date, []);
    groups.get(b.date).push(b);
  }
  let html = "";
  for (const [date, list] of groups) {
    const dayExpense = list.filter((b) => b.type === 1).reduce((sum, b) => sum + b.amount_cents, 0);
    html += `<div class="glass day-card"><div class="day-head"><b>` + fmtDateLabel(date, searching) + `</b><span>` + (dayExpense ? "支出 ¥" + fmtMoney(dayExpense) : "") + `</span></div>`;
    for (const b of list) {
      const sign = b.type === 2 ? "+" : "-";
      html += `<div class="bill ${state.selected.has(b.id) ? "selected" : ""}" data-id="${b.id}">
        <div class="check"></div>
        <div class="emoji">${esc(b.emoji || "📌")}</div>
        <div class="main">
          <div class="cate">${esc(b.category)}</div>
          ${(b.subcategory || b.note) ? `<div class="note">${esc(b.subcategory || b.note)}</div>` : ""}
        </div>
        <div class="amt ${b.type === 2 ? "income" : ""}">${sign}${fmtMoney(b.amount_cents)}</div>
      </div>`;
    }
    html += `</div>`;
  }
  $("#bill-list").innerHTML = html;
  updateBatchBar();
}

function setSelectMode(on) {
  state.selecting = on;
  if (!on) state.selected.clear();
  document.body.classList.toggle("selecting", on);
  $("#batchbar").classList.toggle("hidden", !on);
  $("#btn-select").textContent = on ? "取消" : "多选";
  $$("#bill-list .bill").forEach((row) => row.classList.toggle("selected", on && state.selected.has(Number(row.dataset.id))));
  updateBatchBar();
}

function updateBatchBar() {
  const n = state.selected.size;
  $("#batch-count").textContent = "已选 " + n + " 笔";
  $("#batch-delete").disabled = n === 0;
  $("#batch-move").disabled = n === 0;
  const all = state.bills.length > 0 && state.bills.every((b) => state.selected.has(b.id));
  $("#batch-all").textContent = all ? "取消全选" : "全选";
}

function toggleBill(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  const row = $("#bill-list .bill[data-id='" + id + "']");
  if (row) row.classList.toggle("selected", state.selected.has(id));
  updateBatchBar();
}

function selectAllVisible() {
  const all = state.bills.length > 0 && state.bills.every((b) => state.selected.has(b.id));
  state.selected.clear();
  if (!all) state.bills.forEach((b) => state.selected.add(b.id));
  $$("#bill-list .bill").forEach((row) => row.classList.toggle("selected", state.selected.has(Number(row.dataset.id))));
  updateBatchBar();
}

function selectedBills() {
  return state.bills.filter((b) => state.selected.has(b.id));
}

function openBatchMove() {
  const chosen = selectedBills();
  if (!chosen.length) return toast("先选账单");
  const types = [...new Set(chosen.map((b) => b.type))];
  if (types.length > 1) return toast("支出和收入要分开移动");
  state.batchType = types[0];
  const tops = state.categories.filter((c) => c.type === state.batchType && c.parent_id == null && !c.hidden);
  if (!tops.length) return toast("没有可用的分类");
  $("#batch-category").innerHTML = tops.map((c) => `<option value="${c.id}">${esc(c.emoji)} ${esc(c.name)}</option>`).join("");
  fillBatchSubcats();
  $("#batch-move-hint").textContent = "已选 " + chosen.length + " 笔，全部移到下面这个分类";
  $("#sheet-batch").classList.remove("hidden");
}

function fillBatchSubcats() {
  const catId = Number($("#batch-category").value);
  const kids = state.categories.filter((c) => c.parent_id === catId && !c.hidden);
  $("#batch-subcategory").innerHTML = `<option value="">无</option>` +
    kids.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
}

async function batchDelete() {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (!confirm("删除选中的 " + ids.length + " 笔账单？")) return;
  const btn = $("#batch-delete");
  btn.disabled = true;
  try {
    const res = await api("/api/bills/batch/delete", { method: "POST", body: { ids } });
    const removed = res.count ?? ids.length;
    state.total.n = Math.max(0, state.total.n - removed);
    $("#top-meta").textContent = state.total.n ? "共 " + state.total.n + " 笔" : "";
    toast("已删除 " + removed + " 笔");
    setSelectMode(false);
    await reloadCategories();
    await refreshVisible();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function batchMove() {
  const ids = [...state.selected];
  if (!ids.length) return toast("先选账单");
  const btn = $("#batch-save");
  btn.disabled = true;
  try {
    const res = await api("/api/bills/batch/move", {
      method: "POST",
      body: {
        ids,
        category_id: Number($("#batch-category").value),
        subcategory_id: $("#batch-subcategory").value ? Number($("#batch-subcategory").value) : null,
      },
    });
    const moved = res.count ?? ids.length;
    closeSheets();
    setSelectMode(false);
    toast("已移动 " + moved + " 笔");
    await reloadCategories();
    await refreshVisible();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

$("#bill-list").addEventListener("click", (e) => {
  const row = e.target.closest(".bill");
  if (!row) return;
  const bill = state.bills.find((b) => b.id === Number(row.dataset.id));
  if (!bill) return;
  if (state.selecting) {
    toggleBill(bill.id);
    return;
  }
  openEdit(bill);
});

$("#btn-select").addEventListener("click", () => setSelectMode(!state.selecting));
$("#batch-all").addEventListener("click", selectAllVisible);
$("#batch-delete").addEventListener("click", batchDelete);
$("#batch-move").addEventListener("click", openBatchMove);
$("#batch-category").addEventListener("change", fillBatchSubcats);
$("#batch-save").addEventListener("click", batchMove);

let searchTimer;
$("#search").addEventListener("input", (e) => {
  state.searching = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadBills, 250);
});

/* ---------- 统计 ---------- */
async function loadStats() {
  const data = await api("/api/stats?month=" + state.month + "&today=" + todayStr());
  state.stats = data;
  renderStats();
}

function renderStats() {
  $("#month-label-2").textContent = fmtMonth(state.month);
  const s = state.stats;
  if (!s) return;
  renderWeek();
  const get = (t) => (s.summary.find((x) => x.type === t) || { total: 0, n: 0 });
  const expense = get(1).total || 0;
  const income = get(2).total || 0;

  $("#stat-cards").innerHTML = `
    <div class="stat"><div class="k">支出</div><div class="v">¥${fmtMoney(expense)}</div></div>
    <div class="stat"><div class="k">收入</div><div class="v green">¥${fmtMoney(income)}</div></div>
    <div class="stat"><div class="k">结余</div><div class="v">¥${fmtMoney(income - expense)}</div></div>`;

  const cats = s.byCategory.filter((c) => c.type === 1);
  const max = Math.max(1, ...cats.map((c) => c.total));
  $("#cat-bars").innerHTML = cats.length
    ? cats.map((c) => `
      <div class="bar-row">
        <div class="nm">${esc(c.emoji)} ${esc(c.name)}</div>
        <div class="track"><div class="fill" style="width:${Math.max(3, (c.total / max) * 100)}%"></div></div>
        <div class="val">${fmtMoney(c.total)}</div>
        <div class="pct">${expense ? (c.total / expense < 0.005 ? "<1" : Math.round((c.total / expense) * 100)) : 0}%</div>
      </div>`).join("")
    : `<div class="empty">这个月还没有支出</div>`;

  const tmax = Math.max(1, ...s.trend.flatMap((t) => [t.expense, t.income]));
  $("#trend").innerHTML = s.trend.map((t) => `
    <div class="col">
      <div class="bars">
        <div class="b" style="height:${(t.expense / tmax) * 100}%" title="支出 ${fmtMoney(t.expense)}"></div>
        <div class="b in" style="height:${(t.income / tmax) * 100}%" title="收入 ${fmtMoney(t.income)}"></div>
      </div>
      <div class="lb">${Number(t.month.split("-")[1])}月</div>
    </div>`).join("");

  const incomes = s.byCategory.filter((c) => c.type === 2);
  $("#income-list").innerHTML = incomes.length
    ? incomes.map((c) => `
      <div class="bar-row">
        <div class="nm">${esc(c.emoji)} ${esc(c.name)}</div>
        <div class="track"><div class="fill" style="width:${Math.max(3, (c.total / Math.max(1, ...incomes.map((x) => x.total))) * 100)}%;background:var(--income-grad)"></div></div>
        <div class="val">${fmtMoney(c.total)}</div>
      </div>`).join("")
    : `<div class="empty">这个月还没有收入</div>`;
}

function renderWeek() {
  const w = state.stats && state.stats.week;
  if (!w) return;
  $("#week-total").textContent = "¥" + fmtMoney(w.total);
  const [sy, sm, sd] = w.start.split("-").map(Number);
  const [, em, ed] = w.end.split("-").map(Number);
  $("#week-range").textContent = `${sm}/${sd} - ${em}/${ed}`;
  $("#week-prev").textContent = "上周 ¥" + fmtMoney(w.prevTotal);

  const pill = $("#week-compare");
  const diff = w.total - w.prevTotal;
  let text = "—";
  let down = false;
  if (!w.prevTotal && !w.total) text = "—";
  else if (!w.prevTotal) text = "本周开始";
  else if (diff === 0) text = "与上周持平";
  else {
    const pct = Math.round((Math.abs(diff) / w.prevTotal) * 100);
    text = (diff > 0 ? "↑ " : "↓ ") + pct + "%";
    down = diff < 0;
  }
  pill.textContent = text;
  pill.classList.toggle("down", down);

  const max = Math.max(1, ...w.days.map((d) => d.total));
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  $("#week-bars").innerHTML = w.days.map((d) => {
    const day = new Date(d.date + "T00:00:00");
    const h = d.total ? Math.max(4, (d.total / max) * 100) : 3;
    return `<div class="week-col ${d.date === w.end ? "today" : ""}">
      <div class="week-amt">${d.total ? fmtMoney(d.total) : ""}</div>
      <div class="week-bar-wrap"><div class="week-bar" style="height:${h}%" title="${d.date} 支出 ¥${fmtMoney(d.total)}"></div></div>
      <div class="week-lb">周${names[day.getDay()]}</div>
    </div>`;
  }).join("");
}

async function loadSavings() {
  const data = await api("/api/savings");
  state.savings = data;
  renderSavings();
}

function renderSavings() {
  const s = state.savings || { total: 0, goal: 0, count: 0, entries: [] };
  $("#savings-total").textContent = fmtMoney(s.total);
  const pct = s.goal > 0 ? Math.round((s.total / s.goal) * 100) : 0;
  $("#savings-fill").style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (s.goal > 0) {
    $("#savings-pct").textContent = pct + "%";
    $("#savings-sub").textContent = s.total >= s.goal
      ? `目标 ¥${fmtMoney(s.goal)} · 已达成`
      : `目标 ¥${fmtMoney(s.goal)} · 还差 ¥${fmtMoney(s.goal - s.total)}`;
    $("#btn-goal").textContent = "改目标";
  } else {
    $("#savings-pct").textContent = "—";
    $("#savings-sub").textContent = s.count ? `已存 ${s.count} 笔，设个目标更有动力` : "还没有设目标";
    $("#btn-goal").textContent = "设目标";
  }
  $("#savings-list").innerHTML = s.entries.length
    ? s.entries.map((e) => {
      const out = e.amount_cents < 0;
      return `<div class="savings-row">
        <span class="d">${e.date.slice(5)}</span>
        <span class="n">${esc(e.note || (out ? "取出" : "存入"))}</span>
        <span class="a ${out ? "out" : ""}">${out ? "-" : "+"}¥${fmtMoney(Math.abs(e.amount_cents))}</span>
        <button type="button" class="del" data-del="${e.id}">删除</button>
      </div>`;
    }).join("")
    : "";
}

function openSavingsSheet(mode, dir = "in") {
  state.savingsMode = mode;
  state.savingsDir = dir;
  $("#savings-title").textContent = mode === "goal" ? "设攒钱目标" : dir === "out" ? "取出一笔" : "存一笔";
  $("#savings-dir-seg").classList.toggle("hidden", mode === "goal");
  $("#savings-date-field").classList.toggle("hidden", mode === "goal");
  $("#savings-note-field").classList.toggle("hidden", mode === "goal");
  $("#savings-hint").textContent = mode === "goal"
    ? "填 0 可以取消目标"
    : dir === "out" ? "从攒钱总额里扣掉" : "加到攒钱总额里";
  $$("#savings-dir-seg button").forEach((b) => b.classList.toggle("active", b.dataset.dir === dir));
  $("#savings-amount").value = mode === "goal" && state.savings?.goal
    ? (state.savings.goal / 100).toFixed(2)
    : "";
  $("#savings-date").value = todayStr();
  $("#savings-note").value = "";
  $("#sheet-savings").classList.remove("hidden");
  setTimeout(() => $("#savings-amount").focus(), 100);
}

async function saveSavings() {
  const btn = $("#savings-save");
  if (btn.disabled) return;
  try {
    const raw = $("#savings-amount").value.trim();
    if (!raw) return toast("填一下金额");
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return toast("填一下金额");
    btn.disabled = true;
    if (state.savingsMode === "goal") {
      await api("/api/savings/goal", { method: "PUT", body: { goal: amount.toFixed(2) } });
      toast(amount ? "目标已保存" : "目标已取消");
    } else {
      if (amount <= 0) return toast("金额要大于 0");
      await api("/api/savings", {
        method: "POST",
        body: {
          amount: amount.toFixed(2),
          direction: state.savingsDir,
          date: $("#savings-date").value,
          note: $("#savings-note").value,
        },
      });
      toast(state.savingsDir === "out" ? "已取出" : "已存入");
    }
    closeSheets();
    await loadSavings();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 月份切换 ---------- */
function shiftMonth(delta) {
  const [y, m] = state.month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.month = ym(d);
  refreshVisible();
}

["prev-month", "prev-month-2"].forEach((id) => $("#" + id).addEventListener("click", () => shiftMonth(-1)));
["next-month", "next-month-2"].forEach((id) => $("#" + id).addEventListener("click", () => shiftMonth(1)));

/* ---------- 编辑 ---------- */
function openEdit(bill) {
  state.editing = { ...bill, amount: (bill.amount_cents / 100).toFixed(2) };
  $("#edit-amount").value = state.editing.amount;
  $("#edit-date").value = bill.date;
  $("#edit-time").value = bill.time;
  $$("#edit-type-seg button").forEach((b) => b.classList.toggle("active", Number(b.dataset.type) === bill.type));
  fillEditCategories();
  $("#sheet-edit").classList.remove("hidden");
}

function fillEditCategories() {
  const list = state.categories.filter((c) => c.type === state.editing.type && c.parent_id == null);
  $("#edit-category").innerHTML = list.map((c) => `<option value="${c.id}">${esc(c.emoji)} ${esc(c.name)}</option>`).join("");
  $("#edit-category").value = String(state.editing.category_id);
  fillEditSubcats();
}

function fillEditSubcats() {
  const kids = state.categories.filter((c) => c.parent_id === state.editing.category_id);
  const sel = $("#edit-subcategory");
  sel.innerHTML = `<option value="">无</option>` + kids.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  sel.value = state.editing.subcategory_id ? String(state.editing.subcategory_id) : "";
  sel.disabled = kids.length === 0;
}

$("#edit-category").addEventListener("change", (e) => {
  state.editing.category_id = Number(e.target.value);
  state.editing.subcategory_id = null;
  fillEditSubcats();
});

$("#edit-type-seg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-type]");
  if (!btn) return;
  state.editing.type = Number(btn.dataset.type);
  $$("#edit-type-seg button").forEach((b) => b.classList.toggle("active", b === btn));
  const list = state.categories.filter((c) => c.type === state.editing.type);
  if (list.length) state.editing.category_id = list[0].id;
  state.editing.subcategory_id = null;
  fillEditCategories();
});

$("#edit-save").addEventListener("click", async () => {
  const amount = $("#edit-amount").value;
  if (!(parseFloat(amount) > 0)) return toast("金额不对");
  try {
    await api("/api/bills/" + state.editing.id, {
      method: "PATCH",
      body: {
        amount,
        type: state.editing.type,
        category_id: Number($("#edit-category").value),
        subcategory_id: Number($("#edit-subcategory").value) || null,
        date: $("#edit-date").value,
        time: $("#edit-time").value,
      },
    });
    closeSheets();
    toast("已保存");
    await refreshVisible();
  } catch (err) { toast(err.message); }
});

$("#edit-delete").addEventListener("click", async () => {
  if (!confirm("删除这笔账单？")) return;
  try {
    await api("/api/bills/" + state.editing.id, { method: "DELETE" });
    closeSheets();
    state.total.n = Math.max(0, state.total.n - 1);
    $("#top-meta").textContent = state.total.n ? "共 " + state.total.n + " 笔" : "";
    toast("已删除");
    await refreshVisible();
  } catch (err) { toast(err.message); }
});

/* ---------- 分类管理 ---------- */
function openCats() {
  renderCatSheet();
  $("#sheet-cats").classList.remove("hidden");
}

function renderCatSheet() {
  const rowHtml = (c, child) => `
        <div class="cat-manage ${child ? "child" : ""}">
          <div class="emoji">${esc(c.emoji)}</div>
          <div class="nm">${esc(c.name)}<span class="cnt"> · ${c.used || 0} 笔</span></div>
          <button type="button" class="mini-btn" data-hide="${c.id}" data-hidden="${c.hidden}">${c.hidden ? "显示" : "隐藏"}</button>
          ${Number(c.used) ? "" : `<button type="button" class="mini-btn danger" data-del="${c.id}">删除</button>`}
        </div>`;
  const block = (t, title) => {
    const tops = state.categories.filter((c) => c.type === t && c.parent_id == null);
    return `<div class="cat-title" style="font-size:12px;color:var(--muted);padding:14px 0 2px">${title}</div>` +
      tops.map((p) => rowHtml(p, false) +
        state.categories.filter((k) => k.parent_id === p.id).map((k) => rowHtml(k, true)).join("")
      ).join("");
  };
  $("#cats-list").innerHTML = block(1, "支出分类") + block(2, "收入分类");
  refreshParentOptions();
}

function refreshParentOptions() {
  const type = Number($("#new-type").value);
  const tops = state.categories.filter((c) => c.type === type && c.parent_id == null);
  const cur = $("#new-parent").value;
  $("#new-parent").innerHTML = `<option value="">不挂上级（新建大类）</option>` +
    tops.map((c) => `<option value="${c.id}">挂到「${esc(c.name)}」下面</option>`).join("");
  if (tops.some((c) => String(c.id) === cur)) $("#new-parent").value = cur;
}

$("#cats-list").addEventListener("click", async (e) => {
  const hideBtn = e.target.closest("[data-hide]");
  const delBtn = e.target.closest("[data-del]");
  if (hideBtn) {
    const id = Number(hideBtn.dataset.hide);
    const cat = state.categories.find((c) => c.id === id);
    await api("/api/categories/" + id, { method: "PATCH", body: { hidden: cat.hidden ? 0 : 1 } });
    await reloadCategories();
    renderCatSheet();
    renderCats();
  }
  if (delBtn) {
    const id = Number(delBtn.dataset.del);
    if (!confirm("删除这个分类？")) return;
    try {
      await api("/api/categories/" + id, { method: "DELETE" });
      await reloadCategories();
      renderCatSheet();
      renderCats();
    } catch (err) { toast(err.message); }
  }
});

$("#btn-add-cat").addEventListener("click", async () => {
  const name = $("#new-name").value.trim();
  const emoji = $("#new-emoji").value.trim() || "📌";
  const type = Number($("#new-type").value);
  const parentId = $("#new-parent").value ? Number($("#new-parent").value) : null;
  if (!name) return toast("填个分类名");
  try {
    await api("/api/categories", { method: "POST", body: { name, type, emoji, parent_id: parentId } });
    $("#new-name").value = "";
    await reloadCategories();
    renderCatSheet();
    renderCats();
    toast("已添加");
  } catch (err) { toast(err.message); }
});

$("#new-type").addEventListener("change", refreshParentOptions);

async function reloadCategories() {
  const data = await api("/api/categories");
  state.categories = data.categories || [];
}

/* ---------- 导入导出 ---------- */
$("#btn-export").addEventListener("click", () => {
  window.location.href = "/api/export.csv";
});
$("#btn-export-savings").addEventListener("click", () => {
  window.location.href = "/api/export-savings.csv";
});

$("#btn-import").addEventListener("click", () => $("#file-input").click());

$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseCSV(text);
    if (rows.length < 2) return toast("文件里没有数据");
    const header = rows[0].map((h) => h.trim());
    const find = (...names) => header.findIndex((h) => names.some((n) => h === n || h.toLowerCase() === n));
    const iDate = find("日期", "date");
    const iTime = find("时间", "time");
    const iType = find("收支", "类型", "type");
    const iAmount = find("金额", "amount");
    const iCate = find("分类", "类别", "category");
    const iNote = find("备注", "note", "说明");
    const iSub = find("子类", "二级分类", "subcategory");
    const iIcon = find("图标", "emoji");
    const iId = find("账单ID", "编号", "id", "external_id");
    if (iDate < 0 || iAmount < 0) return toast("表头需要包含「日期」和「金额」");

    const items = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const date = (row[iDate] || "").trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const rawAmount = (row[iAmount] || "").replace(/[^\d.\-]/g, "").trim();
      const negative = rawAmount.startsWith("-");
      let type = negative ? 2 : 1;
      if (iType >= 0) {
        const tv = (row[iType] || "").trim();
        type = /收入|income|^\+/i.test(tv) ? 2 : 1;
      }
      const amount = Math.abs(parseFloat(rawAmount));
      if (!(amount > 0)) continue;
      items.push({
        date,
        time: iTime >= 0 ? (row[iTime] || "").trim() : "12:00",
        type,
        amount: String(amount),
        category: iCate >= 0 ? (row[iCate] || "").trim() : "其它",
        subcategory: iSub >= 0 ? (row[iSub] || "").trim() : "",
        emoji: iIcon >= 0 ? (row[iIcon] || "").trim() : "",
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
        external_id: iId >= 0 ? (row[iId] || "").trim() : null,
      });
    }
    if (!items.length) return toast("没有解析出有效账单");

    let inserted = 0, skipped = 0;
    for (let i = 0; i < items.length; i += 400) {
      const chunk = items.slice(i, i + 400);
      toast(`导入中 ${Math.min(i + 400, items.length)} / ${items.length}`);
      const res = await api("/api/import", { method: "POST", body: { items: chunk } });
      inserted += res.inserted || 0;
      skipped += res.skipped || 0;
    }
    await reloadCategories();
    renderCats();
    const info = await api("/api/bootstrap?month=" + state.month);
    state.total = info.total;
    $("#top-meta").textContent = "共 " + state.total.n + " 笔";
    toast(`导入完成：新增 ${inserted} 笔`);
    if (skipped) toast(`导入完成：新增 ${inserted} 笔，跳过 ${skipped} 笔`);
    if (state.view === "list") await loadBills();
    if (state.view === "stats") await loadStats();
  } catch (err) {
    toast(err.message);
  }
});

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], val = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { val += '"'; i++; }
        else quoted = false;
      } else val += ch;
    } else {
      if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(val); val = ""; }
      else if (ch === "\n") { row.push(val); rows.push(row); row = []; val = ""; }
      else if (ch !== "\r") val += ch;
    }
  }
  if (val !== "" || row.length) { row.push(val); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}

/* ---------- 导航 ---------- */
function switchView(view) {
  state.view = view;
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + view).classList.remove("hidden");
  const isFanzhuo = view === "fanzhuo";
  $(".topbar").classList.toggle("hidden", isFanzhuo);
  document.body.classList.toggle("fanzhuo-mode", isFanzhuo);
  if (!isFanzhuo) document.body.classList.remove("fanzhuo-modal-open");
  if (isFanzhuo) {
    const frame = $("#fanzhuo-frame");
    if (frame.getAttribute("src") !== frame.dataset.src) frame.setAttribute("src", frame.dataset.src);
  }
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "list") loadBills();
  if (view === "stats") Promise.all([loadStats(), loadSavings()]);
  if (view === "me") renderMe();
  window.scrollTo(0, 0);
}

$$(".tabbar button").forEach((btn) => btn.addEventListener("click", () => {
  switchView(btn.dataset.view);
}));

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || !event.data) return;
  if (event.data.type === "fanzhuo:navigate") {
    switchView(["entry", "list", "stats", "me"].includes(event.data.view) ? event.data.view : "entry");
  }
  if (event.data.type === "fanzhuo:modal") {
    document.body.classList.toggle("fanzhuo-modal-open", !!event.data.open);
  }
  if (event.data.type === "fanzhuo:auth") {
    showLogin();
  }
});

function refreshVisible() {
  if (state.view === "list") loadBills();
  else if (state.view === "stats") Promise.all([loadStats(), loadSavings()]);
}

function renderMe() {
  const t = state.total;
  const me = state.me;
  $("#me-account").textContent = me ? me.username : "—";
  $("#btn-accounts").classList.toggle("hidden", !me || me.role !== "admin");
  $("#me-meta").textContent = t.n
    ? `共 ${t.n} 笔账单，${t.minDate || ""} 至 ${t.maxDate || ""}`
    : "还没有账单";
}

function renderAccounts(users) {
  const me = state.me;
  $("#accounts-list").innerHTML = users.length
    ? users.map((u) => {
        const tags = [];
        if (me && u.id === me.id) tags.push("当前账号");
        if (u.role === "admin") tags.push("管理员");
        return `<div class="account-item">
          <div><b>${esc(u.username)}</b><div class="muted small">${Number(u.bills || 0)} 笔账单</div></div>
          <span class="account-badge ${u.role === "admin" ? "admin" : ""}">${tags.join(" · ") || "账号"}</span>
        </div>`;
      }).join("")
    : `<div class="empty">还没有账号</div>`;
}

async function openAccounts() {
  $("#sheet-accounts").classList.remove("hidden");
  try {
    const data = await api("/api/users");
    renderAccounts(data.users || []);
  } catch (err) {
    $("#accounts-list").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function addUser() {
  const username = $("#new-user-name").value.trim();
  const password = $("#new-user-pass").value;
  if (!username) return toast("填一个账号名");
  if (password.length < 8) return toast("密码至少 8 位");
  const btn = $("#btn-add-user");
  btn.disabled = true;
  try {
    await api("/api/users", { method: "POST", body: { username, password } });
    $("#new-user-name").value = "";
    $("#new-user-pass").value = "";
    const data = await api("/api/users");
    renderAccounts(data.users || []);
    toast("账号已添加");
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 弹层 ---------- */
function closeSheets() {
  $$(".sheet").forEach((s) => s.classList.add("hidden"));
}
$$("[data-close]").forEach((el) => el.addEventListener("click", closeSheets));

$("#btn-cats").addEventListener("click", openCats);
$("#btn-accounts").addEventListener("click", openAccounts);
$("#btn-add-user").addEventListener("click", addUser);
$("#new-user-pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addUser();
  }
});
$("#btn-goal").addEventListener("click", () => openSavingsSheet("goal"));
$("#btn-deposit").addEventListener("click", () => openSavingsSheet("in", "in"));
$("#btn-withdraw").addEventListener("click", () => openSavingsSheet("in", "out"));
$$("#savings-dir-seg button").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.savingsDir = btn.dataset.dir;
    $$("#savings-dir-seg button").forEach((b) => b.classList.toggle("active", b === btn));
    $("#savings-title").textContent = btn.dataset.dir === "out" ? "取出一笔" : "存一笔";
    $("#savings-hint").textContent = btn.dataset.dir === "out" ? "从攒钱总额里扣掉" : "加到攒钱总额里";
  });
});
$("#savings-save").addEventListener("click", saveSavings);
$("#savings-amount").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveSavings();
  }
});
$("#savings-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del]");
  if (!btn || !confirm("删掉这笔攒钱记录？")) return;
  try {
    await api("/api/savings/" + btn.dataset.del, { method: "DELETE" });
    await loadSavings();
    toast("已删除");
  } catch (err) {
    toast(err.message);
  }
});
$("#btn-logout").addEventListener("click", async () => {
  if (!confirm("退出登录？")) return;
  await api("/api/logout", { method: "POST" });
  showLogin();
});

/* ---------- 启动 ---------- */
(async function start() {
  try {
    await boot();
    showApp();
  } catch (err) {
    showLogin();
  }
})();
