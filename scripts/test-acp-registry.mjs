import assert from "node:assert/strict";
import { AcpRegistryClient, npxLaunchSpec } from "../server/providers/acp/registry.ts";

const registry = await new AcpRegistryClient().list(true);
assert.match(registry.version, /^1\./);
assert.ok(registry.agents.length >= 20);
for (const id of ["claude-acp", "codex-acp", "gemini", "grok-build"]) assert.ok(registry.agents.some((agent) => agent.id === id), `missing ${id}`);

const gemini = registry.agents.find((agent) => agent.id === "gemini");
const launch = npxLaunchSpec(gemini);
assert.ok(launch);
assert.equal(launch.registryId, "gemini");
assert.ok(launch.args.includes("--acp"));
assert.ok(launch.package.endsWith(`@${gemini.version}`));

console.log(`ACP Registry ${registry.version} verified with ${registry.agents.length} agents`);
