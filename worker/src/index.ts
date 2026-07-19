import { Hono } from "hono";
import { cors } from "hono/cors";

interface Env {
  FILE_KV: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  SECRET_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

// Serve frontend static files via ASSETS binding
const STATIC_PATHS = ["/", "/download.html", "/download", "/style.css", "/app.js", "/favicon.ico"];
STATIC_PATHS.forEach((path) => {
  app.get(path, async (c) => {
    let assetPath = path;
    if (path === "/") assetPath = "/index.html";
    return c.env.ASSETS.fetch(new URL(assetPath, c.req.url));
  });
});

function generateId(len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < len; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function createDownloadToken(
  secret: string,
  fileId: string,
  passwordHash: string,
  ttlMinutes: number
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + ttlMinutes * 60 * 1000;
  const payload = `${fileId}:${passwordHash}:${expiresAt}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sigHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { token: `${payload}:${sigHex}`, expiresAt };
}

async function verifyDownloadToken(
  secret: string,
  token: string
): Promise<{ fileId: string; valid: boolean }> {
  const parts = token.split(":");
  if (parts.length !== 4) return { fileId: "", valid: false };
  const [fileId, passwordHash, expiresAtStr, sigHex] = parts;
  const expiresAt = parseInt(expiresAtStr);
  if (Date.now() > expiresAt) return { fileId, valid: false };

  const payload = `${fileId}:${passwordHash}:${expiresAt}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const valid = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payload));
  return { fileId, valid };
}

// POST /api/upload
app.post("/api/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");
  const expiryHours = parseInt(formData.get("expiry") as string) || 24;
  const password = (formData.get("password") as string) || "";

  if (!file || !(file instanceof File)) {
    return c.json({ error: "未选择文件" }, 400);
  }

  const maxSize = 25 * 1024 * 1024;
  if (file.size > maxSize) {
    return c.json({ error: "文件大小超过 25MB 限制" }, 400);
  }

  const fileId = generateId();
  const passwordHash = password ? await sha256(password) : "";

  const kvKey = `file:${fileId}`;
  await c.env.FILE_KV.put(kvKey, file.stream(), {
    metadata: { name: file.name, type: file.type || "application/octet-stream" },
  });

  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO files (id, name, size, type, kv_key, password_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(fileId, file.name, file.size, file.type || "application/octet-stream", kvKey, passwordHash, expiresAt)
    .run();

  return c.json({ id: fileId, password: password || undefined });
});

// GET /api/files/:id
app.get("/api/files/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();

  if (!row) {
    return c.json({ error: "文件不存在或已过期" }, 404);
  }

  if (row.expires_at && new Date(row.expires_at as string) < new Date()) {
    return c.json({ error: "文件已过期" }, 410);
  }

  return c.json({
    name: row.name,
    size: row.size,
    type: row.type,
    hasPassword: !!row.password_hash,
  });
});

// POST /api/files/:id/verify
app.post("/api/files/:id/verify", async (c) => {
  const id = c.req.param("id");
  const { password } = await c.req.json<{ password: string }>();

  if (!password) {
    return c.json({ error: "请输入密码" }, 400);
  }

  const row = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();

  if (!row) {
    return c.json({ error: "文件不存在" }, 404);
  }

  const inputHash = await sha256(password);
  if (inputHash !== row.password_hash) {
    return c.json({ error: "密码错误" }, 403);
  }

  const { token } = await createDownloadToken(c.env.SECRET_KEY, id, row.password_hash as string, 10);
  return c.json({ token });
});

// GET /api/download/:id
app.get("/api/download/:id", async (c) => {
  const id = c.req.param("id");
  const token = c.req.query("token");

  const row = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
  if (!row) {
    return c.json({ error: "文件不存在" }, 404);
  }

  if (row.password_hash) {
    if (!token) {
      return c.json({ error: "需要验证密码" }, 401);
    }
    const { valid } = await verifyDownloadToken(c.env.SECRET_KEY, token);
    if (!valid) {
      return c.json({ error: "Token 无效或已过期" }, 403);
    }
  }

  const kvValue = await c.env.FILE_KV.get(row.kv_key as string, "arrayBuffer");
  if (!kvValue) {
    return c.json({ error: "文件数据丢失" }, 500);
  }

  const contentType = (row.type as string) || "application/octet-stream";
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.name as string)}`);

  return new Response(kvValue, { headers });
});

// Cleanup expired files
async function cleanupExpired(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT id, kv_key FROM files WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
  ).all();

  for (const row of rows.results) {
    await env.FILE_KV.delete(row.kv_key as string);
    await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(row.id).run();
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env) => {
    await cleanupExpired(env);
  },
};
