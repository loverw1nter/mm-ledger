import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_PASSWORD?: string;
  SESSION_SECRET?: string;
};

type UserRow = {
  id: number;
  username: string;
  role: string;
  password_hash: string;
  salt: string;
};

type AppEnv = {
  Bindings: Bindings;
  Variables: { user: UserRow };
};

const app = new Hono<AppEnv>();

const COOKIE_NAME = "mm_session";
const SESSION_DAYS = 90;
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

function constantEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

async function derivePassword(password: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(saltHex).buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomHex(16);
  return { hash: await derivePassword(password, salt), salt };
}

async function verifyPassword(password: string, user: UserRow): Promise<boolean> {
  if (!user.password_hash || !user.salt) return false;
  const hash = await derivePassword(password, user.salt);
  return constantEqual(hash, user.password_hash);
}

async function makeToken(userId: number, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = await hmacHex(secret, `mm:${userId}:${exp}`);
  return `${userId}.${exp}.${sig}`;
}

async function readToken(token: string | undefined, secret: string): Promise<number | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const userId = Number(parts[0]);
  const exp = Number(parts[1]);
  const sig = parts[2];
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const expect = await hmacHex(secret, `mm:${userId}:${exp}`);
  return constantEqual(expect, sig) ? userId : null;
}

const attempts = new Map<string, { n: number; t: number }>();

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path === "/api/login" || path === "/api/health") return await next();
  const userId = await readToken(getCookie(c, COOKIE_NAME), c.env.SESSION_SECRET || "dev-secret");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const user = await c.env.DB.prepare(
    "SELECT id, username, role, password_hash, salt FROM users WHERE id = ?"
  ).bind(userId).first<UserRow>();
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  return await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/login", async (c) => {
  const ip = c.req.header("cf-connecting-ip") || "local";
  const rec = attempts.get(ip);
  const now = Date.now();
  if (rec && rec.n >= 8 && now - rec.t < 10 * 60 * 1000) {
    return c.json({ error: "尝试次数过多，请 10 分钟后再试" }, 429);
  }
  const body = await c.req.json().catch(() => ({} as any));
  const username = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const user = username
    ? await c.env.DB.prepare(
        "SELECT id, username, role, password_hash, salt FROM users WHERE username = ?"
      ).bind(username).first<UserRow>()
    : null;

  let ok = false;
  if (user && user.password_hash && user.salt) {
    ok = await verifyPassword(password, user);
  } else if (user && c.env.APP_PASSWORD && password === c.env.APP_PASSWORD) {
    const hashed = await hashPassword(password);
    await c.env.DB.prepare(
      "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?"
    ).bind(hashed.hash, hashed.salt, user.id).run();
    ok = true;
  }

  if (!user || !ok) {
    attempts.set(ip, { n: (rec && now - rec.t < 10 * 60 * 1000 ? rec.n : 0) + 1, t: now });
    await new Promise((r) => setTimeout(r, 400));
    return c.json({ error: "账号或密码不对" }, 401);
  }

  attempts.delete(ip);
  const token = await makeToken(user.id, c.env.SESSION_SECRET || "dev-secret");
  const isHttps = new URL(c.req.url).protocol === "https:";
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return c.json({
    ok: true,
    user: { id: user.id, username: user.username, role: user.role },
  });
});

app.get("/api/me", (c) => {
  const u = c.get("user");
  return c.json({ user: { id: u.id, username: u.username, role: u.role } });
});

app.get("/api/users", async (c) => {
  const me = c.get("user");
  if (me.role !== "admin") return c.json({ error: "只有管理员能查看账号" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.created_at,
            (SELECT COUNT(*) FROM bills b WHERE b.user_id = u.id) AS bills
     FROM users u ORDER BY u.id`
  ).all();
  return c.json({ users: rows.results });
});

app.post("/api/users", async (c) => {
  const me = c.get("user");
  if (me.role !== "admin") return c.json({ error: "只有管理员能添加账号" }, 403);
  const body = await c.req.json().catch(() => ({} as any));
  const username = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(username)) {
    return c.json({ error: "账号名要 2-24 位，只能用文字、数字、下划线或短横线" }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: "密码至少 8 位" }, 400);
  }
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first<any>();
  if (exists) return c.json({ error: "这个账号名已经有人用了" }, 400);

  const hashed = await hashPassword(password);
  try {
    const r = await c.env.DB.prepare(
      "INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, 'user')"
    ).bind(username, hashed.hash, hashed.salt).run();
    const userId = Number(r.meta.last_row_id);
    await seedUserCategories(c.env.DB, userId);
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO app_settings (user_id, key, value) VALUES (?, 'savings_goal_cents', '0')"
    ).bind(userId).run();
    return c.json({ ok: true, user: { id: userId, username, role: "user" } });
  } catch {
    return c.json({ error: "这个账号名已经有人用了" }, 400);
  }
});

app.post("/api/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

const DEFAULT_CATEGORIES: Array<[string, number, string, number, number]> = [
  ["午饭", 1, "🍚", 0, 0],
  ["晚饭", 1, "🍜", 0, 1],
  ["饮品", 1, "🧋", 0, 2],
  ["购物", 1, "🛍️", 0, 3],
  ["日用", 1, "🧴", 0, 4],
  ["交通", 1, "🚌", 0, 5],
  ["洗衣服", 1, "🧺", 0, 6],
  ["水果", 1, "🍎", 0, 7],
  ["美容", 1, "💄", 0, 8],
  ["医疗", 1, "💊", 0, 9],
  ["书籍", 1, "📚", 0, 10],
  ["学习", 1, "📖", 0, 11],
  ["办公", 1, "💻", 0, 12],
  ["维修", 1, "🔧", 0, 13],
  ["捐赠", 1, "🎁", 0, 14],
  ["红包", 1, "🧧", 0, 15],
  ["快递", 1, "📦", 0, 16],
  ["追星", 1, "⭐", 0, 17],
  ["游戏", 1, "🎮", 0, 18],
  ["电子契约", 1, "📱", 0, 19],
  ["旅行", 1, "✈️", 0, 20],
  ["其它", 1, "📌", 0, 21],
  ["蔬菜", 1, "🥬", 1, 22],
  ["运动", 1, "🏃", 1, 23],
  ["娱乐", 1, "🎬", 1, 24],
  ["住房", 1, "🏠", 1, 25],
  ["家庭", 1, "👪", 1, 26],
  ["社交", 1, "🍻", 1, 27],
  ["烟酒", 1, "🚬", 1, 28],
  ["数码", 1, "🖥️", 1, 29],
  ["汽车", 1, "🚗", 1, 30],
  ["宠物", 1, "🐱", 1, 31],
  ["礼金", 1, "💌", 1, 32],
  ["礼品", 1, "🎀", 1, 33],
  ["彩票", 1, "🎫", 1, 34],
  ["还款", 1, "💳", 1, 35],
  ["借出", 1, "↗️", 1, 36],
  ["餐饮", 1, "🍽️", 1, 37],
  ["服饰", 1, "👕", 1, 38],
  ["零食", 1, "🍪", 1, 39],
  ["通讯", 1, "📞", 1, 40],
  ["工资", 2, "💰", 0, 0],
  ["红包", 2, "🧧", 0, 1],
  ["租金", 2, "🏠", 0, 2],
  ["礼金", 2, "💌", 0, 3],
  ["分红", 2, "📈", 0, 4],
  ["理财", 2, "📊", 0, 5],
  ["年终奖", 2, "🎉", 0, 6],
  ["其它", 2, "📌", 0, 7],
  ["借入", 2, "↙️", 0, 8],
  ["收款", 2, "💵", 0, 9],
];

async function seedUserCategories(db: D1Database, userId: number): Promise<void> {
  const stmts = DEFAULT_CATEGORIES.map(([name, type, emoji, hidden, sort]) =>
    db.prepare(
      "INSERT OR IGNORE INTO categories (user_id, name, type, emoji, hidden, sort) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, name, type, emoji, hidden, sort)
  );
  if (stmts.length) await db.batch(stmts);
  const shopping = await db.prepare(
    "SELECT id FROM categories WHERE user_id = ? AND type = 1 AND name = '购物' AND parent_id IS NULL"
  ).bind(userId).first<any>();
  if (shopping) {
    await db.prepare(
      "INSERT OR IGNORE INTO categories (user_id, name, type, emoji, hidden, sort, parent_id) VALUES (?, '团购', 1, '🛒', 0, 0, ?)"
    ).bind(userId, shopping.id).run();
  }
}

function toCents(v: unknown): number | null {
  const s = String(v ?? "").trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(n)) return null;
  return n;
}

function cleanDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

function cleanTime(v: unknown): string {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "12:00";
  const h = Math.min(23, parseInt(m[1], 10));
  const mi = Math.min(59, parseInt(m[2], 10));
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function monthRange(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [start, `${month}-${String(last).padStart(2, "0")}`];
}

app.get("/api/categories", async (c) => {
  const userId = c.get("user").id;
  const rows = await c.env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM bills b WHERE b.user_id = ? AND (b.category_id = c.id OR b.subcategory_id = c.id)) AS used
     FROM categories c
     WHERE c.user_id = ?
     ORDER BY c.type, CASE WHEN c.parent_id IS NULL THEN 0 ELSE 1 END, c.sort, c.id`
  ).bind(userId, userId).all();
  return c.json({ categories: rows.results });
});

app.post("/api/categories", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({} as any));
  const name = String(body.name ?? "").trim();
  let type = Number(body.type) === 2 ? 2 : 1;
  const emoji = String(body.emoji ?? "📌").trim().slice(0, 8) || "📌";
  if (!name) return c.json({ error: "分类名不能为空" }, 400);
  let parentId: number | null = null;
  if (body.parent_id !== undefined && body.parent_id !== null && body.parent_id !== "") {
    const parent = await c.env.DB.prepare(
      "SELECT id, type FROM categories WHERE id = ? AND parent_id IS NULL AND user_id = ?"
    ).bind(Number(body.parent_id), userId).first<any>();
    if (!parent) return c.json({ error: "上级分类不存在" }, 400);
    parentId = parent.id;
    type = parent.type;
  }
  const max = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(sort),0) AS m FROM categories WHERE user_id = ? AND type = ? AND COALESCE(parent_id,0) = COALESCE(?,0)"
  ).bind(userId, type, parentId).first<any>();
  try {
    const r = await c.env.DB.prepare(
      "INSERT INTO categories (user_id, name, type, emoji, sort, parent_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, name, type, emoji, (max?.m ?? 0) + 1, parentId).run();
    return c.json({ ok: true, id: r.meta.last_row_id });
  } catch {
    return c.json({ error: "已经有同名分类了" }, 400);
  }
});

app.patch("/api/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({} as any));
  const fields: string[] = [];
  const values: any[] = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return c.json({ error: "分类名不能为空" }, 400);
    fields.push("name = ?");
    values.push(name);
  }
  if (body.emoji !== undefined) {
    fields.push("emoji = ?");
    values.push(String(body.emoji).trim().slice(0, 8) || "📌");
  }
  if (body.hidden !== undefined) {
    fields.push("hidden = ?");
    values.push(body.hidden ? 1 : 0);
  }
  if (body.sort !== undefined) {
    fields.push("sort = ?");
    values.push(Number(body.sort) || 0);
  }
  if (!fields.length) return c.json({ ok: true });
  values.push(id, userId);
  try {
    await c.env.DB.prepare(`UPDATE categories SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).bind(...values).run();
  } catch {
    return c.json({ error: "已经有同名分类了" }, 400);
  }
  return c.json({ ok: true });
});

app.delete("/api/categories/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("user").id;
  const used = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bills WHERE user_id = ? AND (category_id = ? OR subcategory_id = ?)"
  ).bind(userId, id, id).first<any>();
  const kids = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE user_id = ? AND parent_id = ?").bind(userId, id).first<any>();
  if ((kids?.n ?? 0) > 0) return c.json({ error: "这个分类下还有子类，不能删" }, 400);
  if ((used?.n ?? 0) > 0) return c.json({ error: "这个分类下还有账单，不能删" }, 400);
  await c.env.DB.prepare("DELETE FROM categories WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return c.json({ ok: true });
});

app.get("/api/bills", async (c) => {
  const month = (c.req.query("month") || "").slice(0, 7);
  const type = Number(c.req.query("type") || 0);
  const q = (c.req.query("q") || "").trim();
  const all = c.req.query("scope") === "all";
  const userId = c.get("user").id;
  if (!all && !/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "month 参数不对" }, 400);
  const params: any[] = [userId];
  let sql = "SELECT b.id, b.type, b.amount_cents, b.category_id, b.subcategory_id, b.date, b.time, b.note, " +
            "c.name AS category, c.emoji, s.name AS subcategory, s.emoji AS sub_emoji " +
            "FROM bills b JOIN categories c ON c.id = b.category_id AND c.user_id = b.user_id " +
            "LEFT JOIN categories s ON s.id = b.subcategory_id AND s.user_id = b.user_id " +
            "WHERE b.user_id = ?";
  if (!all) {
    const [start, end] = monthRange(month);
    sql += " AND b.date BETWEEN ? AND ?";
    params.push(start, end);
  }
  if (type === 1 || type === 2) {
    sql += " AND b.type = ?";
    params.push(type);
  }
  if (q) {
    sql += " AND (b.note LIKE ? OR c.name LIKE ? OR s.name LIKE ?)";
    params.push("%" + q + "%", "%" + q + "%", "%" + q + "%");
  }
  sql += " ORDER BY b.date DESC, b.time DESC, b.id DESC";
  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ bills: rows.results });
});

app.post("/api/bills", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({} as any));
  const type = Number(body.type) === 2 ? 2 : 1;
  const cents = toCents(body.amount);
  const date = cleanDate(body.date);
  const time = cleanTime(body.time);
  const note = String(body.note ?? "").slice(0, 500);
  const categoryId = Number(body.category_id);
  if (cents === null || cents === 0) return c.json({ error: "金额不对" }, 400);
  if (!date) return c.json({ error: "日期不对" }, 400);
  const cat = await c.env.DB.prepare(
    "SELECT id, type FROM categories WHERE id = ? AND user_id = ?"
  ).bind(categoryId, userId).first<any>();
  if (!cat) return c.json({ error: "分类不存在" }, 400);
  let subId: number | null = null;
  if (body.subcategory_id) {
    const sub = await c.env.DB.prepare(
      "SELECT id FROM categories WHERE id = ? AND parent_id = ? AND user_id = ?"
    ).bind(Number(body.subcategory_id), categoryId, userId).first<any>();
    if (!sub) return c.json({ error: "子类不属于这个分类" }, 400);
    subId = sub.id;
  }
  const r = await c.env.DB.prepare(
    `INSERT INTO bills (user_id, type, amount_cents, category_id, subcategory_id, date, time, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(userId, type, Math.abs(cents), categoryId, subId, date, time, note).run();
  return c.json({ ok: true, id: r.meta.last_row_id });
});

app.patch("/api/bills/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("user").id;
  const existing = await c.env.DB.prepare(
    "SELECT id, category_id, subcategory_id FROM bills WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<any>();
  if (!existing) return c.json({ error: "账单不存在" }, 404);
  const body = await c.req.json().catch(() => ({} as any));
  const fields: string[] = [];
  const values: any[] = [];
  let nextCategory = Number(existing.category_id);

  if (body.amount !== undefined) {
    const cents = toCents(body.amount);
    if (cents === null || cents === 0) return c.json({ error: "金额不对" }, 400);
    fields.push("amount_cents = ?");
    values.push(Math.abs(cents));
  }
  if (body.type !== undefined) {
    fields.push("type = ?");
    values.push(Number(body.type) === 2 ? 2 : 1);
  }
  if (body.category_id !== undefined) {
    const categoryId = Number(body.category_id);
    const cat = await c.env.DB.prepare(
      "SELECT id FROM categories WHERE id = ? AND user_id = ? AND parent_id IS NULL"
    ).bind(categoryId, userId).first<any>();
    if (!cat) return c.json({ error: "分类不存在" }, 400);
    fields.push("category_id = ?");
    values.push(categoryId);
    nextCategory = categoryId;
    if (body.subcategory_id === undefined) {
      fields.push("subcategory_id = NULL");
    }
  }
  if (body.subcategory_id !== undefined) {
    let subId: number | null = null;
    if (body.subcategory_id) {
      const sub = await c.env.DB.prepare(
        "SELECT id FROM categories WHERE id = ? AND parent_id = ? AND user_id = ?"
      ).bind(Number(body.subcategory_id), nextCategory, userId).first<any>();
      if (!sub) return c.json({ error: "子类不属于这个分类" }, 400);
      subId = sub.id;
    }
    fields.push("subcategory_id = ?");
    values.push(subId);
  }
  if (body.date !== undefined) {
    const date = cleanDate(body.date);
    if (!date) return c.json({ error: "日期不对" }, 400);
    fields.push("date = ?");
    values.push(date);
  }
  if (body.time !== undefined) {
    fields.push("time = ?");
    values.push(cleanTime(body.time));
  }
  if (body.note !== undefined) {
    fields.push("note = ?");
    values.push(String(body.note).slice(0, 500));
  }
  if (!fields.length) return c.json({ ok: true });
  fields.push("updated_at = datetime('now')");
  values.push(id, userId);
  await c.env.DB.prepare(
    `UPDATE bills SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`
  ).bind(...values).run();
  return c.json({ ok: true });
});

app.delete("/api/bills/:id", async (c) => {
  const userId = c.get("user").id;
  await c.env.DB.prepare("DELETE FROM bills WHERE id = ? AND user_id = ?")
    .bind(Number(c.req.param("id")), userId).run();
  return c.json({ ok: true });
});

function cleanBillIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
  )).slice(0, 2000);
}

app.post("/api/bills/batch/delete", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({} as any));
  const ids = cleanBillIds(body.ids);
  if (!ids.length) return c.json({ error: "没有选中账单" }, 400);
  const r = await c.env.DB.prepare(
    "DELETE FROM bills WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))"
  ).bind(userId, JSON.stringify(ids)).run();
  return c.json({ ok: true, count: Number(r.meta.changes || 0) });
});

app.post("/api/bills/batch/move", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({} as any));
  const ids = cleanBillIds(body.ids);
  const categoryId = Number(body.category_id);
  if (!ids.length) return c.json({ error: "没有选中账单" }, 400);
  const cat = await c.env.DB.prepare(
    "SELECT id, type FROM categories WHERE id = ? AND parent_id IS NULL AND user_id = ?"
  ).bind(categoryId, userId).first<any>();
  if (!cat) return c.json({ error: "分类不存在" }, 400);
  let subId: number | null = null;
  if (body.subcategory_id) {
    const sub = await c.env.DB.prepare(
      "SELECT id FROM categories WHERE id = ? AND parent_id = ? AND user_id = ?"
    ).bind(Number(body.subcategory_id), categoryId, userId).first<any>();
    if (!sub) return c.json({ error: "子类不属于这个分类" }, 400);
    subId = sub.id;
  }
  const types = await c.env.DB.prepare(
    "SELECT DISTINCT type FROM bills WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))"
  ).bind(userId, JSON.stringify(ids)).all();
  if (!types.results.length) return c.json({ error: "没有找到账单" }, 400);
  if (types.results.some((row: any) => Number(row.type) !== Number(cat.type))) {
    return c.json({ error: "选中的支出和收入要分开移动" }, 400);
  }
  const r = await c.env.DB.prepare(
    "UPDATE bills SET category_id = ?, subcategory_id = ?, updated_at = datetime('now') " +
    "WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))"
  ).bind(categoryId, subId, userId, JSON.stringify(ids)).run();
  return c.json({ ok: true, count: Number(r.meta.changes || 0) });
});

function monthList(month: string, count: number): string[] {
  const [y, m] = month.split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function addDays(date: string, delta: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

app.get("/api/stats", async (c) => {
  const userId = c.get("user").id;
  const month = (c.req.query("month") || "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "month 参数不对" }, 400);
  const [start, end] = monthRange(month);
  const months = monthList(month, 6);
  const trendStart = months[0] + "-01";
  const today = cleanDate(c.req.query("today")) || new Date().toISOString().slice(0, 10);
  const weekStart = addDays(today, -6);
  const prevStart = addDays(today, -13);

  const [summary, byCat, daily, trend, total, weekRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT type, SUM(amount_cents) AS total, COUNT(*) AS n FROM bills
       WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY type`
    ).bind(userId, start, end).all(),
    c.env.DB.prepare(
      `SELECT c.id, c.name, c.emoji, c.type AS type, SUM(b.amount_cents) AS total, COUNT(*) AS n
       FROM bills b JOIN categories c ON c.id = b.category_id AND c.user_id = b.user_id
       WHERE b.user_id = ? AND b.date BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC`
    ).bind(userId, start, end).all(),
    c.env.DB.prepare(
      `SELECT date, type, SUM(amount_cents) AS total FROM bills
       WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date, type ORDER BY date`
    ).bind(userId, start, end).all(),
    c.env.DB.prepare(
      `SELECT substr(date,1,7) AS ym, type, SUM(amount_cents) AS total FROM bills
       WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY ym, type`
    ).bind(userId, trendStart, end).all(),
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n, MIN(date) AS minDate, MAX(date) AS maxDate FROM bills WHERE user_id = ?"
    ).bind(userId).first<any>(),
    c.env.DB.prepare(
      `SELECT date, SUM(amount_cents) AS total FROM bills
       WHERE user_id = ? AND type = 1 AND date BETWEEN ? AND ? GROUP BY date`
    ).bind(userId, prevStart, today).all(),
  ]);

  const trendMap = new Map<string, { expense: number; income: number }>();
  for (const m of months) trendMap.set(m, { expense: 0, income: 0 });
  for (const row of trend.results as any[]) {
    const cell = trendMap.get(row.ym);
    if (cell) cell[row.type === 2 ? "income" : "expense"] = row.total;
  }

  const weekMap = new Map<string, number>();
  let prevTotal = 0;
  for (const row of weekRows.results as any[]) {
    if (row.date >= weekStart) weekMap.set(row.date, row.total);
    else prevTotal += row.total;
  }
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    return { date, total: weekMap.get(date) || 0 };
  });
  const weekTotal = weekDays.reduce((sum, d) => sum + d.total, 0);

  return c.json({
    month,
    summary: summary.results,
    byCategory: byCat.results,
    daily: daily.results,
    trend: months.map((m) => ({ month: m, ...trendMap.get(m)! })),
    week: { start: weekStart, end: today, total: weekTotal, prevTotal, days: weekDays },
    total,
  });
});

app.get("/api/savings", async (c) => {
  const userId = c.get("user").id;
  const [sum, list, goal] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total, SUM(CASE WHEN amount_cents > 0 THEN 1 ELSE 0 END) AS n FROM savings WHERE user_id = ?"
    ).bind(userId).first<any>(),
    c.env.DB.prepare(
      "SELECT id, amount_cents, date, note FROM savings WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 8"
    ).bind(userId).all(),
    c.env.DB.prepare(
      "SELECT value FROM app_settings WHERE user_id = ? AND key = 'savings_goal_cents'"
    ).bind(userId).first<any>(),
  ]);
  return c.json({
    total: Number(sum?.total || 0),
    count: Number(sum?.n || 0),
    goal: Number(goal?.value || 0),
    entries: list.results,
  });
});

app.post("/api/savings", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({} as any));
  const raw = toCents(body.amount);
  if (raw === null || raw === 0) return c.json({ error: "金额不对" }, 400);
  const direction = body.direction === "out" ? -1 : 1;
  const amount = Math.abs(raw) * direction;
  if (direction < 0) {
    const sum = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM savings WHERE user_id = ?"
    ).bind(userId).first<any>();
    if (Number(sum?.total || 0) + amount < 0) return c.json({ error: "取出的比攒下的还多" }, 400);
  }
  const date = cleanDate(body.date) || new Date().toISOString().slice(0, 10);
  const note = String(body.note ?? "").trim().slice(0, 60);
  const r = await c.env.DB.prepare(
    "INSERT INTO savings (user_id, amount_cents, date, note) VALUES (?, ?, ?, ?)"
  ).bind(userId, amount, date, note).run();
  return c.json({ ok: true, id: Number(r.meta.last_row_id) });
});

app.delete("/api/savings/:id", async (c) => {
  const userId = c.get("user").id;
  await c.env.DB.prepare("DELETE FROM savings WHERE id = ? AND user_id = ?")
    .bind(Number(c.req.param("id")), userId).run();
  return c.json({ ok: true });
});

app.put("/api/savings/goal", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({} as any));
  const goal = toCents(body.goal);
  if (goal === null || goal < 0) return c.json({ error: "目标金额不对" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO app_settings (user_id, key, value) VALUES (?, 'savings_goal_cents', ?) " +
    "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value"
  ).bind(userId, String(goal)).run();
  return c.json({ ok: true });
});

app.get("/api/fanzhuo", async (c) => {
  const userId = c.get("user").id;
  const row = await c.env.DB.prepare(
    "SELECT data, updated_at FROM fanzhuo_state WHERE user_id = ?"
  ).bind(userId).first<any>();
  let data: unknown = null;
  if (row?.data) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = null;
    }
  }
  return c.json({ data, updatedAt: row?.updated_at ?? null });
});

app.put("/api/fanzhuo", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({} as any));
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return c.json({ error: "饭桌数据格式不对" }, 400);
  }
  const json = JSON.stringify(body.data);
  if (json.length > 1_000_000) return c.json({ error: "饭桌数据太大了" }, 413);
  const raw = String(body.updatedAt ?? "");
  const parsed = new Date(raw);
  const updatedAt = Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString();
  await c.env.DB.prepare(
    `INSERT INTO fanzhuo_state (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(userId, json, updatedAt).run();
  return c.json({ ok: true, updatedAt });
});

app.get("/api/bootstrap", async (c) => {
  const month = (c.req.query("month") || "").slice(0, 7);
  const me = c.get("user");
  const cats = await c.env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM bills b WHERE b.user_id = c.user_id AND b.category_id = c.id) AS used
     FROM categories c WHERE c.user_id = ? ORDER BY c.type, c.sort, c.id`
  ).bind(me.id).all();
  const total = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n, MIN(date) AS minDate, MAX(date) AS maxDate FROM bills WHERE user_id = ?"
  ).bind(me.id).first<any>();
  return c.json({
    month,
    categories: cats.results,
    total,
    user: { id: me.id, username: me.username, role: me.role },
  });
});

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get("/api/export.csv", async (c) => {
  const userId = c.get("user").id;
  const from = cleanDate(c.req.query("from")) || "0000-01-01";
  const to = cleanDate(c.req.query("to")) || "9999-12-31";
  const rows = await c.env.DB.prepare(
    `SELECT b.date, b.time, b.type, b.amount_cents, c.name AS category,
            COALESCE(s.name, '') AS subcategory, COALESCE(s.emoji, c.emoji) AS sub_emoji,
            b.note, b.id
     FROM bills b JOIN categories c ON c.id = b.category_id AND c.user_id = b.user_id
     LEFT JOIN categories s ON s.id = b.subcategory_id AND s.user_id = b.user_id
     WHERE b.user_id = ? AND b.date BETWEEN ? AND ? ORDER BY b.date, b.time, b.id`
  ).bind(userId, from, to).all();
  const lines = ["日期,时间,收支,金额,分类,子类,图标,备注,编号"];
  for (const r of rows.results as any[]) {
    lines.push([
      r.date,
      r.time,
      r.type === 2 ? "收入" : "支出",
      (r.amount_cents / 100).toFixed(2),
      r.category,
      r.subcategory,
      r.sub_emoji,
      r.note,
      r.id,
    ].map(csvCell).join(","));
  }
  return new Response("\uFEFF" + lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="ledger-${from}-${to}.csv"`,
    },
  });
});

app.get("/api/export-savings.csv", async (c) => {
  const userId = c.get("user").id;
  const rows = await c.env.DB.prepare(
    "SELECT date, amount_cents, note FROM savings WHERE user_id = ? ORDER BY date, id"
  ).bind(userId).all();
  const lines = ["日期,收支,金额,备注"];
  for (const r of rows.results as any[]) {
    lines.push([
      r.date,
      r.amount_cents > 0 ? "存入" : "取出",
      (Math.abs(r.amount_cents) / 100).toFixed(2),
      r.note,
    ].map(csvCell).join(","));
  }
  return new Response("\uFEFF" + lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="savings.csv"`,
    },
  });
});

app.post("/api/import", async (c) => {
  const userId = c.get("user").id;
  const body = await c.req.json().catch(() => ({} as any));
  const items: any[] = Array.isArray(body.items) ? body.items.slice(0, 1000) : [];
  if (!items.length) return c.json({ error: "没有数据" }, 400);

  const catRows = await c.env.DB.prepare(
    "SELECT id, name, type, parent_id FROM categories WHERE user_id = ?"
  ).bind(userId).all();
  const catMap = new Map<string, number>();
  for (const row of catRows.results as any[]) {
    catMap.set(`${row.type}:${row.parent_id ?? 0}:${row.name}`, row.id);
  }

  const maxRow = await c.env.DB.prepare(
    "SELECT type, COALESCE(parent_id,0) AS pid, COALESCE(MAX(sort),0) AS m FROM categories WHERE user_id = ? GROUP BY type, COALESCE(parent_id,0)"
  ).bind(userId).all();
  const maxSort = new Map<string, number>();
  for (const row of maxRow.results as any[]) maxSort.set(`${row.type}:${row.pid}`, row.m);

  const ensureCategory = async (name: string, type: number, parentId: number | null, emoji = "📌"): Promise<number> => {
    const key = `${type}:${parentId ?? 0}:${name}`;
    const found = catMap.get(key);
    if (found) return found;
    const sortKey = `${type}:${parentId ?? 0}`;
    const nextSort = (maxSort.get(sortKey) ?? 0) + 1;
    const r = await c.env.DB.prepare(
      "INSERT INTO categories (user_id, name, type, emoji, sort, parent_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, name, type, emoji, nextSort, parentId).run();
    const id = Number(r.meta.last_row_id);
    catMap.set(key, id);
    maxSort.set(sortKey, nextSort);
    return id;
  };

  let inserted = 0;
  let skipped = 0;
  const stmts: D1PreparedStatement[] = [];

  for (const it of items) {
    const type = Number(it.type) === 2 ? 2 : 1;
    const cents = toCents(it.amount);
    const date = cleanDate(it.date);
    const name = String(it.category ?? "").trim() || "其它";
    if (cents === null || !date) { skipped++; continue; }
    const catId = await ensureCategory(name, type, null);
    const subName = String(it.subcategory ?? "").trim();
    const subId = subName
      ? await ensureCategory(subName, type, catId, String(it.emoji ?? "").trim().slice(0, 8) || "📌")
      : null;
    stmts.push(c.env.DB.prepare(
      `INSERT OR IGNORE INTO bills (user_id, type, amount_cents, category_id, subcategory_id, date, time, note, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, type, Math.abs(cents), catId, subId, date, cleanTime(it.time), String(it.note ?? "").slice(0, 500), it.external_id ? String(it.external_id) : null));
  }

  for (let i = 0; i < stmts.length; i += 100) {
    const chunk = stmts.slice(i, i + 100);
    const results = await c.env.DB.batch(chunk);
    for (const r of results) inserted += r.meta.changes || 0;
  }

  return c.json({ ok: true, inserted, skipped });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "服务器出错了：" + err.message }, 500);
});

export default app;
