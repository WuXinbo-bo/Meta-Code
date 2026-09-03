import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LOCAL_API_TOKEN_HEADER = "x-metacode-api-token";

export function loadOrCreateDevelopmentApiToken(dataDir: string) {
  const configured = process.env.METACODE_API_TOKEN?.trim();
  if (configured) return configured;
  const directory = path.join(dataDir, "security");
  const file = path.join(directory, "api-token");
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64url"), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = fs.readFileSync(file, "utf8").trim();
  if (token.length < 32) throw new Error("本地 API 令牌无效，请删除 security/api-token 后重启开发服务");
  return token;
}

function tokenMatches(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hostPort(value: string) {
  try {
    const url = new URL(`http://${value}`);
    const hostname = url.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return null;
    return Number(url.port || 80);
  } catch { return null; }
}

export function validateLocalApiRequest(input: {
  pathname: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  apiToken: string;
  allowedPorts: ReadonlySet<number>;
}) {
  if (input.pathname === "/api/health" || input.pathname.startsWith("/api/internal/")) return null;
  const host = String(input.headers.host || "");
  if (!input.allowedPorts.has(hostPort(host) || -1)) return { status: 403, error: "本地 API Host 无效" };
  if (!tokenMatches(String(input.headers[LOCAL_API_TOKEN_HEADER] || ""), input.apiToken)) return { status: 404, error: "Not found" };
  if (!["GET", "HEAD", "OPTIONS"].includes(input.method.toUpperCase())) {
    if (String(input.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return { status: 403, error: "跨站请求已拒绝" };
    const origin = String(input.headers.origin || "");
    if (origin) {
      let originPort = -1;
      try {
        const parsed = new URL(origin);
        if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase())) throw new Error("invalid origin");
        originPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      } catch { return { status: 403, error: "请求来源无效" }; }
      if (!input.allowedPorts.has(originPort)) return { status: 403, error: "跨站请求已拒绝" };
    }
  }
  return null;
}
