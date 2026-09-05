import fs from "node:fs";
import path from "node:path";

export function agentNodeExecutable() {
  const configured = process.env.METACODE_NODE_PATH;
  return configured && fs.existsSync(configured) ? configured : process.execPath;
}

export function registerAgentNode(node: string) {
  process.env.METACODE_NODE_PATH = node;
  const env = nodeToolchainEnvironment(node);
  for (const key of Object.keys(process.env)) if (key.toUpperCase() === "PATH") delete process.env[key];
  process.env.PATH = env.PATH;
}

export function nodeToolchainEnvironment(node: string, input: NodeJS.ProcessEnv = process.env) {
  const env = { ...input };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH";
  const inherited = env[pathKey] || "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  const directory = path.dirname(node);
  env.PATH = [directory, ...inherited.split(path.delimiter).filter((entry) => entry && entry.toLowerCase() !== directory.toLowerCase())].join(path.delimiter);
  if (node !== process.execPath || !process.versions.electron) delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
