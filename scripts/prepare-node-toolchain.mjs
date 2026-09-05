import path from "node:path";
import fsp from "node:fs/promises";
import { NodeToolchainManager, verifyNodeToolchain, toolchainAt } from "../server/runtime/toolchain.ts";
import { DEFAULT_RUNTIME_CONFIGURATION } from "../server/runtime/config.ts";

const output = process.argv[2];
if (!output) throw new Error("Expected a dedicated toolchain output directory");
const destination = path.resolve(output);
const manager = new NodeToolchainManager(destination, path.join(path.dirname(destination), ".downloads"));
// Release builds ship the pinned distribution, not the build machine's Node.
manager.discover = () => toolchainAt(destination);
const toolchain = await manager.ensure(DEFAULT_RUNTIME_CONFIGURATION.network, (progress) => {
  if (progress.totalBytes) console.log(`[node] ${Math.round(progress.downloadedBytes / progress.totalBytes * 100)}%`);
});
if (toolchain.root !== destination) await fsp.cp(toolchain.root, destination, { recursive: true });
await verifyNodeToolchain(toolchainAt(destination));
console.log("[node] isolated Node/npm toolchain certified");
