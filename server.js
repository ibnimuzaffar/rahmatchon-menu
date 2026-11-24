const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

// Load .env if present (no external dependencies required)
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

function loadMenuMap() {
  const menu = JSON.parse(fs.readFileSync(path.join(ROOT, "menu.json"), "utf8"));
  const map = new Map();
  for (const cat of menu) {
    (cat.items || []).forEach((it, idx) => {
      const id = it.id || `${cat.id}-${idx}`;
      map.set(id, it);
    });
  }
  return map;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Telegram limits: ~1 msg/sec per chat, ~20 msg/min per group.
// All messages go to one chat, so send them strictly one by one with a gap.
const TG_MIN_INTERVAL_MS = Number(process.env.TELEGRAM_MIN_INTERVAL_MS) || 3100;
const TG_MAX_RETRIES = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tgQueue = Promise.resolve();
let tgLastSentAt = 0;

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[Telegram dry-run]\n" + text + "\n---");
    return Promise.resolve({ dryRun: true });
  }
  const job = tgQueue.then(() => sendTelegramWithRetry(text));
  tgQueue = job.catch(() => {}); // keep the queue alive after a failure
  return job;
}

async function sendTelegramWithRetry(text) {
  for (let attempt = 0; ; attempt++) {
    const wait = tgLastSentAt + TG_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await sendTelegramRaw(text);
    } catch (err) {
      if (err.retryAfter == null || attempt >= TG_MAX_RETRIES) throw err;
      console.warn(`Telegram 429, retry in ${err.retryAfter}s (attempt ${attempt + 1}/${TG_MAX_RETRIES})`);
      await sleep(err.retryAfter * 1000 + 250);
    } finally {
      tgLastSentAt = Date.now();
    }
  }
}

function sendTelegramRaw(text) {
  const payload = JSON.stringify({ chat_id: CHAT_ID, text });
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
        const out = [];
        res.on("data", c => out.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(out).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(raw));
          } else {
            const err = new Error(`Telegram HTTP ${res.statusCode}: ${raw}`);
            if (res.statusCode === 429) {
              let retryAfter = 5;
              try { retryAfter = JSON.parse(raw).parameters.retry_after || retryAfter; } catch {}
              err.retryAfter = retryAfter;
            }
            reject(err);
          }
        });
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error("Telegram request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const CALL_COOLDOWN_MS = 30 * 1000;
const lastCallAt = new Map();
setInterval(() => {
  const cutoff = Date.now() - CALL_COOLDOWN_MS;
  for (const [k, ts] of lastCallAt) if (ts < cutoff) lastCallAt.delete(k);
}, 60 * 1000).unref();

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (path.basename(filePath).startsWith(".env") || path.basename(filePath) === "server.js") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "POST" && urlPath === "/api/order") {
    try {
      const body = await readJsonBody(req);
      const table = body.table ? String(body.table).trim().slice(0, 20) : null;
      const comment = body.comment ? String(body.comment).trim().slice(0, 500) : "";
      const rawItems = Array.isArray(body.items) ? body.items : [];
      if (!rawItems.length) return sendJson(res, 400, { ok: false, error: "Empty order" });

      const menuMap = loadMenuMap();
      const lines = [];
      let total = 0;

      for (const entry of rawItems) {
        const id = entry && typeof entry.id === "string" ? entry.id : "";
        const qty = Number(entry && entry.qty);
        const item = menuMap.get(id);
        if (!item || item.off || item.p == null || !Number.isInteger(qty) || qty < 1 || qty > 99) {
          return sendJson(res, 400, { ok: false, error: `Invalid item: ${id}` });
        }
        const sum = item.p * qty;
        total += sum;
        const w = item.w ? ` (${item.w})` : "";
        lines.push(`• ${item.n}${w} × ${qty} = ${sum} сом.`);
      }

      const msgParts = [
        `🍽 Новый заказ`,
        `Стол: ${table || "не указан"}`,
        "",
        ...lines,
        "",
        `Итого: ${total} сом.`
      ];
      if (comment) msgParts.push(`Комментарий: ${comment}`);

      const tg = await sendTelegram(msgParts.join("\n"));
      return sendJson(res, 200, { ok: true, dryRun: Boolean(tg.dryRun) });
    } catch (err) {
      console.error("Order error:", err.message);
      return sendJson(res, 500, { ok: false, error: "Failed to process order" });
    }
  }

  if (req.method === "POST" && urlPath === "/api/call") {
    try {
      const body = await readJsonBody(req);
      const table = body.table ? String(body.table).trim().slice(0, 20) : "";
      const type = body.type === "bill" ? "bill" : "waiter";
      if (!table) return sendJson(res, 400, { ok: false, error: "Table is required" });

      // Same table pressing the same button repeatedly → notify only once per cooldown
      const key = `${table}:${type}`;
      const now = Date.now();
      if (now - (lastCallAt.get(key) || 0) < CALL_COOLDOWN_MS) {
        return sendJson(res, 200, { ok: true, deduped: true });
      }
      lastCallAt.set(key, now);

      const text = type === "bill"
        ? `💳 Стол ${table}: просит счёт`
        : `🔔 Стол ${table}: зовёт официанта`;

      const tg = await sendTelegram(text);
      return sendJson(res, 200, { ok: true, dryRun: Boolean(tg.dryRun) });
    } catch (err) {
      console.error("Call error:", err.message);
      return sendJson(res, 500, { ok: false, error: "Failed to send notification" });
    }
  }

  if (req.method === "GET") return serveStatic(req, res);

  res.writeHead(405);
  res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — running in dry-run mode (logging to console).");
  }
});
