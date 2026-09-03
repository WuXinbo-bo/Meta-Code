import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadOrCreateDevelopmentApiToken, validateLocalApiRequest } from "../server/localApiSecurity.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-code-api-security-"));
try {
  const token = loadOrCreateDevelopmentApiToken(root);
  assert.equal(loadOrCreateDevelopmentApiToken(root), token, "开发前后端必须复用同一个本地私有令牌");
  const allowedPorts = new Set([4338, 4339]);
  const request = (overrides = {}) => validateLocalApiRequest({ pathname: "/api/settings", method: "POST", headers: { host: "127.0.0.1:4338", "x-metacode-api-token": token, origin: "http://127.0.0.1:4339" }, apiToken: token, allowedPorts, ...overrides });
  assert.equal(request(), null);
  assert.equal(request({ pathname: "/api/health", headers: { host: "evil.example" } }), null, "Launcher 健康检查保持无令牌可用");
  assert.equal(request({ pathname: "/api/internal/delegation/tasks", headers: { host: "127.0.0.1:4338" } }), null, "内部桥接继续使用独立令牌");
  assert.equal(request({ headers: { host: "127.0.0.1:4338", origin: "http://127.0.0.1:4339" } })?.status, 404);
  assert.equal(request({ headers: { host: "attacker.example:4338", "x-metacode-api-token": token } })?.status, 403);
  assert.equal(request({ headers: { host: "127.0.0.1:4338", "x-metacode-api-token": token, origin: "https://attacker.example" } })?.status, 403);
  assert.equal(request({ headers: { host: "127.0.0.1:4338", "x-metacode-api-token": token, "sec-fetch-site": "cross-site" } })?.status, 403);
  assert.equal(request({ method: "GET", headers: { host: "localhost:4338", "x-metacode-api-token": token } }), null);
  console.log("local API token, host and browser-origin boundaries: ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
