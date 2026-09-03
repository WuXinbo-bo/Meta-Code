import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { NextFunction, Request, Response } from "express";

const scryptAsync = promisify(crypto.scrypt);
const SESSION_COOKIE = "metamodel_session";
const USER_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const LOCAL_TEST_USER_ID = "legacy-unassigned";

export type UserRole = "owner" | "admin" | "support" | "auditor" | "user";
export type UserStatus = "active" | "disabled" | "locked" | "pending_deletion";

export type AuthUser = {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  onboardingCompleted: boolean;
  createdAt: string;
  totpEnabled: boolean;
};

// 本地测试模式只绕过入口认证，不删除或改变正式认证流程。服务器固定监听回环地址，
// 需要恢复认证时将 SKIP_AUTH=false 传给服务端即可。
const LOCAL_TEST_USER: AuthUser = {
  id: LOCAL_TEST_USER_ID,
  username: "local-test",
  role: "owner",
  status: "active",
  onboardingCompleted: true,
  createdAt: "1970-01-01T00:00:00.000Z",
  totpEnabled: false
};

export type AuditInput = {
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  success?: boolean;
  summary?: unknown;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  errorMessage?: string;
};

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      authSessionHash?: string;
      requestId?: string;
    }
  }
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function normalizeUsername(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function validateUsername(username: string) {
  const plainUsername = /^[a-z0-9_][a-z0-9_.-]{2,31}$/.test(username);
  const emailUsername = username.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
  return plainUsername || emailUsername;
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: Buffer, right: Buffer) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(input: Buffer) {
  let bits = 0; let value = 0; let output = "";
  for (const byte of input) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(input: string) {
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const char of input.toUpperCase().replace(/=+$/, "")) {
    const index = BASE32.indexOf(char); if (index < 0) continue;
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
function totpCode(secret: string, time = Date.now()) {
  const counter = Math.floor(time / 30_000);
  const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, "0");
}
function verifyTotp(secret: string, code: string) {
  return [-1, 0, 1].some((window) => {
    const expected = totpCode(secret, Date.now() + window * 30_000);
    return /^\d{6}$/.test(code) && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected));
  });
}

function requestIp(req: Request) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "";
}

function requestAgent(req: Request) {
  return String(req.headers["user-agent"] || "").slice(0, 500);
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function createAuth(runtimeDir: string) {
  const bypassAuth = process.env.SKIP_AUTH !== "false";
  fs.mkdirSync(runtimeDir, { recursive: true });
  const databasePath = process.env.AUTH_DB_PATH || path.join(runtimeDir, "auth.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      onboarding_completed INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      last_login_ip TEXT,
      last_user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
      monthly_token_limit INTEGER NOT NULL DEFAULT 5000000,
      task_timeout_minutes INTEGER NOT NULL DEFAULT 120,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      success INTEGER NOT NULL,
      summary_json TEXT,
      ip_address TEXT,
      user_agent TEXT,
      request_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      ip_address TEXT,
      success INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_releases (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      encrypted_object_path TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      signature TEXT NOT NULL,
      encryption_key_id TEXT NOT NULL,
      status TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      uploaded_by TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      rollback_from TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_user_id);
    CREATE INDEX IF NOT EXISTS login_attempts_lookup_idx ON login_attempts(username, ip_address, created_at);
  `);
  addColumnIfMissing(db, "users", "role", "TEXT NOT NULL DEFAULT 'user'");
  addColumnIfMissing(db, "users", "status", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(db, "users", "last_login_at", "TEXT");
  addColumnIfMissing(db, "users", "last_login_ip", "TEXT");
  addColumnIfMissing(db, "users", "last_user_agent", "TEXT");
  addColumnIfMissing(db, "users", "totp_secret_cipher", "TEXT");
  addColumnIfMissing(db, "users", "totp_enabled", "INTEGER NOT NULL DEFAULT 0");
  db.exec("PRAGMA user_version = 1");
  addColumnIfMissing(db, "sessions", "ip_address", "TEXT");
  addColumnIfMissing(db, "sessions", "user_agent", "TEXT");

  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as { id: string } | undefined;
  if (!owner) {
    const oldest = db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
    if (oldest) db.prepare("UPDATE users SET role = 'owner', status = 'active' WHERE id = ?").run(oldest.id);
  }
  db.prepare(`INSERT OR IGNORE INTO user_quotas (user_id, updated_at) SELECT id, ? FROM users`).run(new Date().toISOString());

  const publicUser = (row: Record<string, unknown>): AuthUser => ({
    id: String(row.id),
    username: String(row.username),
    role: String(row.role || "user") as UserRole,
    status: String(row.status || "active") as UserStatus,
    onboardingCompleted: Boolean(row.onboarding_completed),
    createdAt: String(row.created_at)
    ,totpEnabled: Boolean(row.totp_enabled)
  });

  const bypassUser = () => {
    const row = db.prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1").get() as Record<string, unknown> | undefined;
    return row ? publicUser(row) : LOCAL_TEST_USER;
  };

  const authEncryptionKey = () => {
    const keyFile = process.env.AUTH_ENCRYPTION_KEY_FILE ||
      (process.platform === "win32" ? path.join(runtimeDir, "auth-encryption.key") : "/etc/meta-workbench/auth-encryption.key");
    const encoded = process.env.AUTH_ENCRYPTION_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error("管理员二次验证加密密钥尚未配置");
    return key;
  };
  const encryptSecret = (secret: string) => {
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", authEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  };
  const decryptSecret = (encoded: string) => {
    const payload = Buffer.from(encoded, "base64"); const decipher = crypto.createDecipheriv("aes-256-gcm", authEncryptionKey(), payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
  };

  const audit = (input: AuditInput) => {
    const safeSummary = input.summary == null ? null : JSON.stringify(input.summary).slice(0, 8000);
    db.prepare(`INSERT INTO audit_logs
      (id, actor_user_id, action, target_type, target_id, success, summary_json, ip_address, user_agent, request_id, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`audit_${crypto.randomUUID()}`, input.actorUserId || null, input.action, input.targetType || null,
        input.targetId || null, input.success === false ? 0 : 1, safeSummary, input.ipAddress || null,
        input.userAgent || null, input.requestId || null, input.errorMessage?.slice(0, 1000) || null, new Date().toISOString());
  };

  const auditRequest = (req: Request, input: Omit<AuditInput, "actorUserId" | "ipAddress" | "userAgent" | "requestId">) => {
    audit({ ...input, actorUserId: req.authUser?.id, ipAddress: requestIp(req), userAgent: requestAgent(req), requestId: req.requestId });
  };

  const setSessionCookie = (res: Response, token: string, maxAgeMs: number) => {
    const secure = process.env.COOKIE_SECURE === "true";
    res.setHeader("Set-Cookie", [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict",
      secure ? "Secure" : "", `Max-Age=${Math.floor(maxAgeMs / 1000)}`].filter(Boolean).join("; "));
  };
  const clearSessionCookie = (res: Response) => res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);

  const createSession = (user: AuthUser, req: Request, res: Response) => {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const adminLike = user.role !== "user";
    const maxAgeMs = adminLike ? ADMIN_SESSION_MAX_AGE_MS : USER_SESSION_MAX_AGE_MS;
    const expiresAt = new Date(now.getTime() + maxAgeMs).toISOString();
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
      .run(hashToken(token), user.id, expiresAt, now.toISOString(), requestIp(req), requestAgent(req));
    setSessionCookie(res, token, maxAgeMs);
  };

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (bypassAuth) {
      req.authUser = bypassUser();
      req.authSessionHash = undefined;
      return next();
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: "请先登录" });
    const tokenHash = hashToken(token);
    const row = db.prepare(`SELECT users.*, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`)
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row || String(row.expires_at) <= new Date().toISOString()) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      clearSessionCookie(res);
      return res.status(401).json({ error: "登录已过期，请重新登录" });
    }
    const user = publicUser(row);
    if (user.status !== "active") {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      clearSessionCookie(res);
      return res.status(403).json({ error: user.status === "locked" ? "账号已锁定" : "账号当前不可用" });
    }
    req.authUser = user;
    req.authSessionHash = tokenHash;
    next();
  };

  const requireRoles = (...roles: UserRole[]) => (req: Request, res: Response, next: NextFunction) => {
    if (!req.authUser || !roles.includes(req.authUser.role)) return res.status(403).json({ error: "权限不足" });
    next();
  };

  const recentFailedAttempts = (username: string, ip: string) => {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const row = db.prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE username = ? AND ip_address = ? AND success = 0 AND created_at >= ?")
      .get(username, ip, since) as { count: number };
    return Number(row.count || 0);
  };

  const register = async (req: Request, res: Response) => {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || "");
    if (!validateUsername(username)) return res.status(400).json({ error: "请输入有效邮箱，或 3–32 位用户名" });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "密码长度需为 8–128 位" });
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return res.status(409).json({ error: "该账号已存在" });
    const salt = crypto.randomBytes(16);
    const derived = await scryptAsync(password, salt, 64) as Buffer;
    const now = new Date().toISOString();
    const count = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    const user: AuthUser = { id: `user_${crypto.randomUUID()}`, username, role: Number(count.count) === 0 ? "owner" : "user", status: "active", createdAt: now, onboardingCompleted: false, totpEnabled: false };
    try {
      db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(user.id, username, derived.toString("base64"), salt.toString("base64"), user.role, user.status, now);
      db.prepare("INSERT INTO user_quotas (user_id, updated_at) VALUES (?, ?)").run(user.id, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return res.status(409).json({ error: "该账号已存在" });
      throw error;
    }
    createSession(user, req, res);
    audit({ actorUserId: user.id, action: "auth.register", targetType: "user", targetId: user.id, ipAddress: requestIp(req), userAgent: requestAgent(req), summary: { role: user.role } });
    return res.status(201).json({ user });
  };

  const login = async (req: Request, res: Response) => {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || "");
    const ip = requestIp(req);
    if (recentFailedAttempts(username, ip) >= 8) return res.status(429).json({ error: "登录失败次数过多，请 15 分钟后再试" });
    const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Record<string, unknown> | undefined;
    let valid = false;
    if (row) {
      const derived = await scryptAsync(password, Buffer.from(String(row.password_salt), "base64"), 64) as Buffer;
      valid = safeEqual(derived, Buffer.from(String(row.password_hash), "base64"));
    }
    db.prepare("INSERT INTO login_attempts (id, username, ip_address, success, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`login_${crypto.randomUUID()}`, username, ip, valid ? 1 : 0, new Date().toISOString());
    if (!row || !valid) {
      audit({ action: "auth.login_failed", targetType: "user", targetId: username, success: false, ipAddress: ip, userAgent: requestAgent(req) });
      return res.status(401).json({ error: "账号或密码错误" });
    }
    const user = publicUser(row);
    if (user.status !== "active") return res.status(403).json({ error: user.status === "locked" ? "账号已锁定" : "账号当前不可用" });
    if (user.totpEnabled) {
      const code = String(req.body.totpCode || "").trim();
      const secret = decryptSecret(String(row.totp_secret_cipher || ""));
      if (!code) return res.status(401).json({ error: "请输入管理员动态验证码", totpRequired: true });
      if (!verifyTotp(secret, code)) return res.status(401).json({ error: "动态验证码错误", totpRequired: true });
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE users SET last_login_at = ?, last_login_ip = ?, last_user_agent = ? WHERE id = ?")
      .run(now, ip, requestAgent(req), user.id);
    createSession(user, req, res);
    audit({ actorUserId: user.id, action: "auth.login", targetType: "user", targetId: user.id, ipAddress: ip, userAgent: requestAgent(req) });
    return res.json({ user });
  };

  const logout = (req: Request, res: Response) => {
    if (req.authSessionHash) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(req.authSessionHash);
    auditRequest(req, { action: "auth.logout", targetType: "user", targetId: req.authUser?.id });
    clearSessionCookie(res);
    res.json({ ok: true });
  };

  const completeOnboarding = (req: Request, res: Response) => {
    db.prepare("UPDATE users SET onboarding_completed = 1 WHERE id = ?").run(req.authUser!.id);
    res.json({ user: { ...req.authUser!, onboardingCompleted: true } });
  };

  const getOwnerUserId = () => {
    const row = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
    return row?.id || (bypassAuth ? LOCAL_TEST_USER_ID : null);
  };

  const setupTotp = (user: AuthUser) => {
    if (user.role === "user") throw new Error("普通用户无需配置管理员二次验证");
    const secret = base32Encode(crypto.randomBytes(20));
    db.prepare("UPDATE users SET totp_secret_cipher = ?, totp_enabled = 0 WHERE id = ?").run(encryptSecret(secret), user.id);
    return { secret, otpauthUri: `otpauth://totp/MetaWorkbench:${encodeURIComponent(user.username)}?secret=${secret}&issuer=MetaWorkbench&digits=6&period=30` };
  };
  const enableTotp = (user: AuthUser, code: string) => {
    const row = db.prepare("SELECT totp_secret_cipher FROM users WHERE id = ?").get(user.id) as { totp_secret_cipher?: string } | undefined;
    if (!row?.totp_secret_cipher) throw new Error("请先生成二次验证密钥");
    if (!verifyTotp(decryptSecret(row.totp_secret_cipher), code)) throw new Error("动态验证码错误");
    db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(user.id);
  };

  const derivePassword = async (password: string) => {
    if (password.length < 8 || password.length > 128) throw new Error("密码长度需为 8–128 位");
    const salt = crypto.randomBytes(16);
    const derived = await scryptAsync(password, salt, 64) as Buffer;
    return { hash: derived.toString("base64"), salt: salt.toString("base64") };
  };

  const listUsers = (search = "", limit = 100, offset = 0) => {
    const pattern = `%${search.trim().toLowerCase()}%`;
    return db.prepare(`
      SELECT users.id, users.username, users.role, users.status, users.onboarding_completed, users.created_at,
        users.last_login_at, users.last_login_ip, users.last_user_agent,
        quotas.max_concurrent_tasks, quotas.monthly_token_limit, quotas.task_timeout_minutes,
        (SELECT COUNT(*) FROM sessions WHERE sessions.user_id = users.id AND sessions.expires_at > ?) AS active_sessions
      FROM users LEFT JOIN user_quotas quotas ON quotas.user_id = users.id
      WHERE (? = '%%' OR lower(users.username) LIKE ?)
      ORDER BY users.created_at DESC LIMIT ? OFFSET ?
    `).all(new Date().toISOString(), pattern, pattern, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0));
  };

  const userStats = () => db.prepare(`
    SELECT
      COUNT(*) AS total_users,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_users,
      SUM(CASE WHEN role IN ('owner','admin','support','auditor') THEN 1 ELSE 0 END) AS privileged_users,
      (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS online_sessions
    FROM users
  `).get(new Date().toISOString()) as Record<string, unknown>;

  const createManagedUser = async (input: { username: string; password: string; role?: UserRole; status?: UserStatus }) => {
    const username = normalizeUsername(input.username);
    if (!validateUsername(username)) throw new Error("请输入有效邮箱，或 3–32 位用户名");
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw new Error("该账号已存在");
    const password = await derivePassword(input.password);
    const now = new Date().toISOString();
    const id = `user_${crypto.randomUUID()}`;
    const role = input.role || "user";
    const status = input.status || "active";
    db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, username, password.hash, password.salt, role, status, now);
    db.prepare("INSERT INTO user_quotas (user_id, updated_at) VALUES (?, ?)").run(id, now);
    return publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>);
  };

  const updateManagedUser = (id: string, patch: { role?: UserRole; status?: UserStatus; maxConcurrentTasks?: number; monthlyTokenLimit?: number }) => {
    const current = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!current) throw new Error("用户不存在");
    const role = patch.role || String(current.role) as UserRole;
    const status = patch.status || String(current.status) as UserStatus;
    db.prepare("UPDATE users SET role = ?, status = ? WHERE id = ?").run(role, status, id);
    const currentQuota = db.prepare("SELECT * FROM user_quotas WHERE user_id = ?").get(id) as Record<string, unknown> | undefined;
    db.prepare(`INSERT INTO user_quotas (user_id, max_concurrent_tasks, monthly_token_limit, task_timeout_minutes, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET max_concurrent_tasks=excluded.max_concurrent_tasks,
        monthly_token_limit=excluded.monthly_token_limit, task_timeout_minutes=excluded.task_timeout_minutes, updated_at=excluded.updated_at`)
      .run(id,
        Math.max(1, Number(patch.maxConcurrentTasks ?? currentQuota?.max_concurrent_tasks ?? 1)),
        Math.max(0, Number(patch.monthlyTokenLimit ?? currentQuota?.monthly_token_limit ?? 5_000_000)),
        Math.max(1, Number(currentQuota?.task_timeout_minutes ?? 120)),
        new Date().toISOString());
    if (status !== "active") db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    return publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>);
  };

  const resetManagedPassword = async (id: string, password: string) => {
    const derived = await derivePassword(password);
    const result = db.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?").run(derived.hash, derived.salt, id);
    if (!result.changes) throw new Error("用户不存在");
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  };

  const revokeUserSessions = (id: string) => Number(db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id).changes);

  const anonymizeUser = async (id: string) => {
    const row = db.prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: UserRole } | undefined;
    if (!row) throw new Error("用户不存在");
    if (row.role === "owner") throw new Error("所有者账号不能匿名化");
    const derived = await derivePassword(crypto.randomBytes(32).toString("base64url"));
    db.prepare(`UPDATE users SET username = ?, password_hash = ?, password_salt = ?, role = 'user', status = 'pending_deletion',
      last_login_ip = NULL, last_user_agent = NULL WHERE id = ?`)
      .run(`deleted_${crypto.randomUUID()}@invalid.local`, derived.hash, derived.salt, id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  };

  const listAuditLogs = (limit = 200, offset = 0) => db.prepare(`
    SELECT audit_logs.*, users.username AS actor_username FROM audit_logs
    LEFT JOIN users ON users.id = audit_logs.actor_user_id
    ORDER BY audit_logs.created_at DESC LIMIT ? OFFSET ?
  `).all(Math.min(Math.max(limit, 1), 500), Math.max(offset, 0));

  const cleanupExpiredSessions = () => Number(db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString()).changes);
  const getQuota = (userId: string) => (db.prepare("SELECT * FROM user_quotas WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined) || {
    max_concurrent_tasks: 1, monthly_token_limit: 5_000_000, task_timeout_minutes: 120
  };

  return {
    db, register, login, logout, completeOnboarding, requireAuth, requireRoles, audit, auditRequest,
    getOwnerUserId, publicUser, listUsers, userStats, createManagedUser, updateManagedUser,
    resetManagedPassword, revokeUserSessions, anonymizeUser, listAuditLogs, cleanupExpiredSessions, getQuota,
    setupTotp, enableTotp, isAuthBypassed: () => bypassAuth
  };
}
