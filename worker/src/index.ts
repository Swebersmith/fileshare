import { Hono } from "hono";
import { cors } from "hono/cors";

interface Env {
  FILE_KV: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  SECRET_KEY: string;
  ADMIN_PASSWORD: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

const STATIC_PATHS = ["/", "/download.html", "/download", "/admin", "/admin.html", "/bundle", "/bundle.html", "/style.css", "/app.js", "/favicon.ico"];
STATIC_PATHS.forEach((path) => {
  app.get(path, async (c) => {
    let assetPath = path;
    if (path === "/") assetPath = "/index.html";
    return c.env.ASSETS.fetch(new URL(assetPath, c.req.url));
  });
});

const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB per chunk

function generateId(len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < len; i++) result += chars[bytes[i] % chars.length];
  return result;
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacVerify(secret: string, payload: string, sigHex: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payload));
}

function makeToken(secret: string, payload: string, ttlMinutes: number): Promise<string> {
  const expiresAt = Date.now() + ttlMinutes * 60 * 1000;
  const data = `${payload}:${expiresAt}`;
  return hmacSign(secret, data).then((sig) => `${data}:${sig}`);
}

async function verifyToken(secret: string, token: string): Promise<string | null> {
  const parts = token.split(":");
  if (parts.length < 3) return null;
  const sigHex = parts.pop()!;
  const data = parts.join(":");
  const valid = await hmacVerify(secret, data, sigHex);
  if (!valid) return null;
  const expiresAt = parseInt(parts[parts.length - 1]);
  if (Date.now() > expiresAt) return null;
  return parts.slice(0, -1).join(":"); // return original payload
}

// Store file in KV with optional chunking
async function storeFile(kv: KVNamespace, fileId: string, file: File): Promise<number> {
  if (file.size <= CHUNK_SIZE) {
    await kv.put(`file:${fileId}:0`, file.stream(), {
      metadata: { name: file.name, type: file.type || "application/octet-stream", chunk: 0, total: 1 },
    });
    return 1;
  }

  // Chunking — read as ArrayBuffer then split
  const buffer = await file.arrayBuffer();
  const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
    const chunk = buffer.slice(start, end);
    await kv.put(`file:${fileId}:${i}`, chunk, {
      metadata: { name: file.name, type: file.type || "application/octet-stream", chunk: i, total: totalChunks },
    });
  }
  return totalChunks;
}

// Retrieve file from KV (possibly chunked)
async function retrieveFile(kv: KVNamespace, fileId: string, chunks: number): Promise<{ body: Uint8Array | ReadableStream; contentType: string; name: string } | null> {
  if (chunks === 1) {
    const val = await kv.getWithMetadata(`file:${fileId}:0`, "arrayBuffer");
    if (!val.value) return null;
    const meta = val.metadata as any;
    return { body: new Uint8Array(val.value as ArrayBuffer), contentType: meta?.type || "application/octet-stream", name: meta?.name || "" };
  }

  // Assemble chunks
  const parts: Uint8Array[] = [];
  let name = "";
  let contentType = "application/octet-stream";
  for (let i = 0; i < chunks; i++) {
    const val = await kv.getWithMetadata(`file:${fileId}:${i}`, "arrayBuffer");
    if (!val.value) return null;
    const meta = val.metadata as any;
    if (i === 0) { name = meta?.name || ""; contentType = meta?.type || "application/octet-stream"; }
    parts.push(new Uint8Array(val.value as ArrayBuffer));
  }
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { merged.set(p, offset); offset += p.length; }
  return { body: merged, contentType, name };
}

// Delete file chunks from KV
async function deleteFile(kv: KVNamespace, fileId: string, chunks: number) {
  for (let i = 0; i < chunks; i++) await kv.delete(`file:${fileId}:${i}`);
}

// POST /api/upload — supports multiple files
app.post("/api/upload", async (c) => {
  const formData = await c.req.formData();
  const files = formData.getAll("file").filter((f): f is File => f instanceof File);
  const expiryHours = parseInt(formData.get("expiry") as string) || 24;
  const password = (formData.get("password") as string) || "";
  const mode = (formData.get("mode") as string) || "separate";

  if (files.length === 0) return c.json({ error: "未选择文件" }, 400);

  const passwordHash = password ? await sha256(password) : "";
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();
  const results: { id: string; name: string; link: string }[] = [];

  for (const file of files) {
    const fileId = generateId();
    const kvKey = `file:${fileId}`;
    const chunks = await storeFile(c.env.FILE_KV, fileId, file);

    await c.env.DB.prepare(
      `INSERT INTO files (id, name, size, type, kv_key, password_hash, expires_at, chunks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(fileId, file.name, file.size, file.type || "application/octet-stream", kvKey, passwordHash, expiresAt, chunks).run();

    const link = (mode === "combined") ? "" : `/download?id=${fileId}`;
    results.push({ id: fileId, name: file.name, link });
  }

  if (mode === "combined") {
    const bundleId = generateId(8);
    const fileIds = results.map((r) => r.id).join(",");
    await c.env.DB.prepare(`INSERT INTO bundles (id, file_ids) VALUES (?, ?)`).bind(bundleId, fileIds).run();
    return c.json({ bundleId, password: password || undefined });
  }

  return c.json({ files: results, password: password || undefined });
});

// GET /api/files/:id
app.get("/api/files/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "文件不存在或已过期" }, 404);
  if (row.expires_at && new Date(row.expires_at as string) < new Date()) return c.json({ error: "文件已过期" }, 410);
  return c.json({ name: row.name, size: row.size, type: row.type, hasPassword: !!row.password_hash });
});

// GET /api/bundle/:id
app.get("/api/bundle/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM bundles WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "合集不存在" }, 404);
  const fileIds = (row.file_ids as string).split(",");
  const files: any[] = [];
  for (const fid of fileIds) {
    const f = await c.env.DB.prepare("SELECT id, name, size, type, password_hash, expires_at FROM files WHERE id = ?").bind(fid).first();
    if (f) files.push({ id: f.id, name: f.name, size: f.size, hasPassword: !!f.password_hash });
  }
  return c.json({ files });
});

// POST /api/files/:id/verify
app.post("/api/files/:id/verify", async (c) => {
  const id = c.req.param("id");
  const { password } = await c.req.json<{ password: string }>();
  if (!password) return c.json({ error: "请输入密码" }, 400);
  const row = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "文件不存在" }, 404);
  const inputHash = await sha256(password);
  if (inputHash !== row.password_hash) return c.json({ error: "密码错误" }, 403);
  const token = await makeToken(c.env.SECRET_KEY, `${id}:${row.password_hash}`, 10);
  return c.json({ token });
});

// GET /api/download/:id
app.get("/api/download/:id", async (c) => {
  const id = c.req.param("id");
  const token = c.req.query("token");
  const row = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "文件不存在" }, 404);
  if (row.password_hash) {
    if (!token) return c.json({ error: "需要验证密码" }, 401);
    const payload = await verifyToken(c.env.SECRET_KEY, token);
    if (!payload || payload !== `${id}:${row.password_hash}`) return c.json({ error: "Token 无效或已过期" }, 403);
  }

  const chunks = (row.chunks as number) || 1;
  const result = await retrieveFile(c.env.FILE_KV, id, chunks);
  if (!result) return c.json({ error: "文件数据丢失" }, 500);

  const headers = new Headers();
  headers.set("Content-Type", result.contentType);
  headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.name as string)}`);
  return new Response(result.body, { headers });
});

// GET /api/download/:id/chunk/:n (for chunked download metadata)
app.get("/api/download/:id/chunk/:n", async (c) => {
  const id = c.req.param("id");
  const n = parseInt(c.req.param("n"));
  const { value, metadata } = await c.env.FILE_KV.getWithMetadata(`file:${id}:${n}`, "arrayBuffer");
  if (!value) return c.json({ error: "chunk not found" }, 404);
  const meta = metadata as any;
  const headers = new Headers();
  headers.set("Content-Type", meta?.type || "application/octet-stream");
  headers.set("X-Chunk-Index", String(meta?.chunk || n));
  headers.set("X-Chunk-Total", String(meta?.total || 1));
  return new Response(value as ArrayBuffer, { headers });
});

// Admin auth
async function verifyAdminToken(secret: string, token: string): Promise<boolean> {
  return (await verifyToken(secret, token)) !== null;
}

app.post("/api/admin/login", async (c) => {
  const { password } = await c.req.json<{ password: string }>();
  if (!password || password !== c.env.ADMIN_PASSWORD) return c.json({ error: "密码错误" }, 403);
  const token = await makeToken(c.env.SECRET_KEY, await sha256(password), 60);
  return c.json({ token });
});

async function adminAuth(c: any, next: any) {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return c.json({ error: "未授权" }, 401);
  const valid = await verifyAdminToken(c.env.SECRET_KEY, auth.slice(7));
  if (!valid) return c.json({ error: "Token 无效或已过期" }, 401);
  return next();
}

app.get("/api/admin/files", adminAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, size, type, password_hash, expires_at, created_at FROM files ORDER BY created_at DESC"
  ).all();
  return c.json(results);
});

app.delete("/api/admin/files/:id", adminAuth, async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT kv_key, chunks FROM files WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "文件不存在" }, 404);
  await deleteFile(c.env.FILE_KV, id, (row.chunks as number) || 1);
  await c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// Cleanup
async function cleanupExpired(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT id, chunks FROM files WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
  ).all();
  for (const row of rows.results) {
    await deleteFile(env.FILE_KV, row.id as string, (row.chunks as number) || 1);
    await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(row.id).run();
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env) => { await cleanupExpired(env); },
};
