import fs from "node:fs/promises";
import path from "node:path";
import { activeDataOwner } from "./dataOwnerLease.js";

async function endpointIsWorkbench(port: number, fetchImpl: typeof globalThis.fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const health = await response.json() as { productId?: string };
    return response.ok && health?.productId === "meta-code";
  } catch { return false; }
}

export async function isWorkbenchDataDirActive(dataDir: string, fetchImpl = globalThis.fetch) {
  const root = path.resolve(dataDir);
  if (activeDataOwner(root)) return true;
  const ports = new Set([4338]);
  try {
    const runtime = JSON.parse(await fs.readFile(path.join(root, "desktop", "runtime.json"), "utf8")) as { port?: number };
    if (Number.isInteger(runtime.port) && Number(runtime.port) > 0 && Number(runtime.port) <= 65_535) ports.add(Number(runtime.port));
  } catch { /* Desktop runtime state is optional. */ }
  for (const port of ports) if (await endpointIsWorkbench(port, fetchImpl)) return true;
  return false;
}
