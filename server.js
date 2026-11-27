require("dotenv").config();

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");

const HOST = (process.env.HOST || "127.0.0.1").trim();
const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

const ALLOWED_TABLES = new Set(
  (process.env.ALLOWED_TABLES || "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

// Load and validate public/menu.json on startup
function loadAndValidateMenu() {
  const menuPath = path.join(__dirname, "public", "menu.json");
  const menu = JSON.parse(fs.readFileSync(menuPath, "utf8"));
  const map = new Map();
  for (const cat of menu) {
    for (const it of cat.items || []) {
      if (typeof it.id !== "string" || !it.id.trim()) {
        throw new Error(`Missing item id in category "${cat.id}": ${it.n}`);
      }
      if (map.has(it.id)) {
        throw new Error(`Duplicate item id in menu.json: "${it.id}"`);
      }
      map.set(it.id, it);
    }
  }
  return map;
}

const menuMap = loadAndValidateMenu();
console.log(`Loaded menu.json: ${menuMap.size} unique items.`);

// SQLite database
const db = new Database(path.join(__dirname, "orders.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_no TEXT NOT NULL,
    items TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'confirmed', 'paid', 'cancelled')),
    tg_status TEXT NOT NULL DEFAULT 'pending' CHECK(tg_status IN ('pending', 'sent', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const insertOrderStmt = db.prepare(
  "INSERT INTO orders (table_no, items, comment, status, tg_status) VALUES (?, ?, ?, 'new', 'pending')"
);
const selectOrderStmt = db.prepare("SELECT * FROM orders WHERE id = ?");
const updateTgStatusStmt = db.prepare("UPDATE orders SET tg_status = ? WHERE id = ?");
const selectPendingOrdersStmt = db.prepare("SELECT id FROM orders WHERE tg_status = 'pending' ORDER BY id ASC");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatOrderTelegramText(orderRow) {
  const items = JSON.parse(orderRow.items);
  let total = 0;
  const lines = items.map(({ id, qty }) => {
    const it = menuMap.get(id);
    const sum = it.p * qty;
    total += sum;
    const w = it.w ? ` (${escapeHtml(it.w)})` : "";
    return `• ${escapeHtml(it.n)}${w} × ${qty} = ${sum} сом.`;
  });
  const parts = [
    `🍽 <b>Новый заказ #${orderRow.id}</b>`,
    `Стол: <b>${escapeHtml(orderRow.table_no)}</b>`,
    "",
    ...lines,
    "",
    `Итого: <b>${total} сом.</b>`
  ];
  if (orderRow.comment) {
    parts.push(`Комментарий: ${escapeHtml(orderRow.comment)}`);
  }
  return parts.join("\n");
}

function sendTelegramRaw(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[Telegram dry-run]\n" + text + "\n---");
    return Promise.resolve({ dryRun: true });
  }
  const payload = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        family: 4,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed || {});
            return;
          }
          const err = new Error(`Telegram HTTP ${res.statusCode}: ${raw}`);
          err.statusCode = res.statusCode;
          err.retryAfter = parsed && parsed.parameters && Number(parsed.parameters.retry_after);
          reject(err);
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sequential Telegram queue: max 1 message/sec, up to 5 retries on 429/errors
const tgQueue = [];
let tgWorkerRunning = false;
let lastTgSentAt = 0;

async function sendWithRetry(text) {
  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const elapsed = Date.now() - lastTgSentAt;
    if (elapsed < 1000) await sleep(1000 - elapsed);
    lastTgSentAt = Date.now();
    try {
      return await sendTelegramRaw(text);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const waitSec = err.statusCode === 429 && err.retryAfter > 0 ? err.retryAfter + 1 : 2;
      console.warn(`Telegram retry ${attempt + 1}/${maxRetries} after ${waitSec}s: ${err.message}`);
      await sleep(waitSec * 1000);
    }
  }
}

async function processTgQueue() {
  if (tgWorkerRunning) return;
  tgWorkerRunning = true;
  try {
    while (tgQueue.length) {
      const task = tgQueue.shift();
      try {
        if (task.kind === "order") {
          const row = selectOrderStmt.get(task.orderId);
          if (!row || row.tg_status !== "pending") continue;
          await sendWithRetry(formatOrderTelegramText(row));
          updateTgStatusStmt.run("sent", row.id);
        } else if (task.kind === "call") {
          await sendWithRetry(task.text);
        }
      } catch (err) {
        console.error("Telegram delivery failed:", err.message);
        if (task.kind === "order") {
          updateTgStatusStmt.run("failed", task.orderId);
        }
      }
    }
  } finally {
    tgWorkerRunning = false;
  }
}

function enqueueOrder(orderId) {
  tgQueue.push({ kind: "order", orderId });
  processTgQueue();
}

function enqueueCall(text) {
  tgQueue.push({ kind: "call", text });
  processTgQueue();
}

// Re-enqueue pending orders on startup
for (const row of selectPendingOrdersStmt.all()) {
  enqueueOrder(row.id);
}

// Express app
const app = express();
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10kb" }));

app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: "Payload too large" });
  }
  next(err);
});

const ipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests from this IP" }
});

const tableDeviceKey = req => {
  const tbl = req.body && req.body.table ? String(req.body.table).trim() : "none";
  const dev = (req.get("x-device-id") || req.ip || "unknown").slice(0, 64);
  return `${tbl}:${dev}`;
};

const orderTableOnlyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: req => (req.body && req.body.table != null ? String(req.body.table).trim() : "none"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many orders for this table" }
});

const orderTableLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: tableDeviceKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many orders for this device" }
});

const callTableLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: tableDeviceKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many calls for this table" }
});

app.post("/api/orders", ipLimiter, orderTableOnlyLimiter, orderTableLimiter, (req, res) => {
  const tableNo = req.body && req.body.table != null ? String(req.body.table).trim() : "";
  if (!ALLOWED_TABLES.has(tableNo)) {
    return res.status(400).json({ ok: false, error: "Invalid table number" });
  }

  const rawComment = req.body && req.body.comment != null ? String(req.body.comment).trim() : "";
  if (rawComment.length > 200) {
    return res.status(400).json({ ok: false, error: "Comment must be <= 200 characters" });
  }

  const rawItems = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!rawItems.length || rawItems.length > 50) {
    return res.status(400).json({ ok: false, error: "Order must contain 1..50 items" });
  }

  const cleanItems = [];
  for (const entry of rawItems) {
    const id = entry && typeof entry.id === "string" ? entry.id.trim() : "";
    const qty = Number(entry && entry.qty);
    const item = menuMap.get(id);
    if (!item || item.off || item.p == null || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return res.status(400).json({ ok: false, error: `Invalid item or qty: ${id}` });
    }
    cleanItems.push({ id, qty });
  }

  const info = insertOrderStmt.run(tableNo, JSON.stringify(cleanItems), rawComment);
  const orderId = Number(info.lastInsertRowid);
  enqueueOrder(orderId);

  return res.status(201).json({ ok: true, orderId });
});

app.post("/api/call", ipLimiter, callTableLimiter, (req, res) => {
  const tableNo = req.body && req.body.table != null ? String(req.body.table).trim() : "";
  if (!ALLOWED_TABLES.has(tableNo)) {
    return res.status(400).json({ ok: false, error: "Invalid table number" });
  }
  const type = req.body && req.body.type;
  if (type !== "waiter" && type !== "bill") {
    return res.status(400).json({ ok: false, error: "Invalid call type" });
  }

  const text = type === "bill"
    ? `💳 <b>Стол ${escapeHtml(tableNo)}</b>: просит счёт`
    : `🔔 <b>Стол ${escapeHtml(tableNo)}</b>: зовёт официанта`;

  enqueueCall(text);
  return res.json({ ok: true });
});

// Serve static files strictly from public/
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — running in dry-run mode.");
  }
});
