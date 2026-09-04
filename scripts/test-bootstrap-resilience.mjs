import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, app] = await Promise.all([
  readFile(new URL("../server/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8")
]);

const bootstrapStart = server.indexOf('app.get("/api/bootstrap"');
const bootstrapEnd = server.indexOf('app.get("/api/runtime/codex"', bootstrapStart);
assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart, "bootstrap route must exist");
const bootstrapRoute = server.slice(bootstrapStart, bootstrapEnd);
assert.doesNotMatch(
  bootstrapRoute,
  /cliRuntimeManager\.detect/,
  "first-screen bootstrap must not scan third-party CLI runtimes"
);
assert.match(bootstrapRoute, /nativeProviders/, "bootstrap must expose cached native providers immediately");
assert.match(server, /workflowRepository\.listNavigation\(ownerUserId\)/, "navigation must use lightweight workflow summaries");
assert.doesNotMatch(
  server.slice(server.indexOf("function navigationSnapshot"), bootstrapStart),
  /workspaceAgentConfig\(workspace\)[\s\S]*workspaceAgentConfig\(workspace\)/,
  "navigation must resolve each workspace Agent configuration once"
);

assert.equal(
  server.match(/app\.get\("\/api\/provider-controls"/g)?.length,
  1,
  "provider controls must have one authoritative route"
);
assert.match(server, /providerControlBundleCache/, "provider scans must have a short-lived cache");
assert.match(server, /providerControlBundleLoads/, "concurrent provider scans must coalesce");
assert.match(
  server,
  /if \(!force \|\| pending\.force\) return pending\.promise;[\s\S]*await pending\.promise;[\s\S]*providerControlBundleCache\.delete/,
  "a forced scan arriving behind a normal scan must perform a fresh follow-up"
);

const realtimeEffectStart = app.indexOf("const refreshProviderControls = async");
const realtimeEffectEnd = app.indexOf("const loadWorkspaceTree = async", realtimeEffectStart);
assert.ok(realtimeEffectStart >= 0 && realtimeEffectEnd > realtimeEffectStart, "realtime refresh coordination must exist");
const realtimeEffect = app.slice(realtimeEffectStart, realtimeEffectEnd);
assert.match(
  realtimeEffect,
  /reason === "connected" \|\| reason === "error" \|\| reason === "watchdog"/,
  "initial connection and transient stream errors must not duplicate full bootstrap requests"
);
assert.match(
  realtimeEffect,
  /const next = await requestCoordinatorRef\.current\.run[\s\S]*setData\(\(current\)/,
  "provider data must only replace existing UI state after a successful response"
);
assert.match(
  app,
  /setData\(\(current\) => mergeBootstrapProviderState\(current, next\)\)/,
  "a core bootstrap refresh must preserve background-loaded third-party providers"
);

const treeReconcileStart = app.indexOf("const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile", realtimeEffectEnd);
const treeReconcileEnd = app.indexOf("return () =>", treeReconcileStart);
assert.ok(treeReconcileStart >= 0 && treeReconcileEnd > treeReconcileStart, "tree reconciliation must exist");
assert.doesNotMatch(
  app.slice(treeReconcileStart, treeReconcileEnd),
  /force:\s*true/,
  "stream reconciliation must reuse the file-tree cache instead of forcing a full rescan"
);

console.log("bootstrap critical-path and background provider resilience tests passed");
