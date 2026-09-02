import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { request } from "undici";
import type { RuntimeNetworkConfig } from "./config.js";
import { networkDispatcher, type ResolvedNpmArtifact } from "./source.js";

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export type ArtifactDownloadProgress = {
  artifact: string;
  downloadedBytes: number;
  totalBytes?: number;
  bytesPerSecond: number;
  resumed: boolean;
};

function cacheName(artifact: ResolvedNpmArtifact) {
  const digest = crypto.createHash("sha256").update(artifact.url).digest("hex").slice(0, 16);
  return `${artifact.packageName.replace(/[^a-zA-Z0-9._-]+/g, "-")}-${artifact.version}-${digest}.tgz`;
}

async function verifyIntegrity(file: string, integrity: string) {
  const [algorithm, expected] = integrity.split("-", 2);
  if (!algorithm || !expected || !["sha512", "sha256"].includes(algorithm)) throw new Error("下载源提供了不支持的完整性格式");
  const hash = crypto.createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  if (hash.digest("base64") !== expected) throw new Error("下载文件完整性校验失败");
}

function totalFromHeaders(headers: Record<string, string | string[] | undefined>, offset: number) {
  const range = String(headers["content-range"] || "");
  const match = /\/(\d+)$/.exec(range);
  if (match) return Number(match[1]);
  const length = Number(headers["content-length"] || 0);
  return length > 0 ? offset + length : undefined;
}

async function requestDownload(url: string, offset: number, config: RuntimeNetworkConfig, dispatcher: ReturnType<typeof networkDispatcher>) {
  let currentUrl = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") throw new Error("下载地址仅支持 HTTP 或 HTTPS");
    const response = await request(currentUrl, {
      dispatcher,
      headers: offset > 0 ? { range: `bytes=${offset}-` } : undefined,
      headersTimeout: 20_000,
      bodyTimeout: config.inactivityTimeoutSeconds * 1_000
    });
    if (!REDIRECT_STATUS_CODES.has(response.statusCode)) return response;
    const location = String(response.headers.location || "");
    await response.body.dump();
    if (!location) throw new Error(`下载重定向缺少目标地址：HTTP ${response.statusCode}`);
    if (redirects === MAX_REDIRECTS) throw new Error(`下载重定向超过 ${MAX_REDIRECTS} 次`);
    currentUrl = new URL(location, currentUrl);
  }
  throw new Error("下载重定向失败");
}

export async function downloadArtifact(
  artifact: ResolvedNpmArtifact,
  cacheRoot: string,
  config: RuntimeNetworkConfig,
  onProgress: (progress: ArtifactDownloadProgress) => void
) {
  await fsp.mkdir(cacheRoot, { recursive: true });
  const target = path.join(cacheRoot, cacheName(artifact));
  if (fs.existsSync(target)) {
    try { await verifyIntegrity(target, artifact.integrity); return target; }
    catch { await fsp.rm(target, { force: true }); }
  }
  const partial = `${target}.part`;
  let offset = 0;
  try { offset = (await fsp.stat(partial)).size; } catch { /* Fresh download. */ }
  const dispatcher = networkDispatcher(config);
  try {
    const response = await requestDownload(artifact.url, offset, config, dispatcher);
    if (response.statusCode === 416 && offset > 0) {
      try {
        await verifyIntegrity(partial, artifact.integrity);
        await fsp.rename(partial, target);
        return target;
      } catch {
        await fsp.rm(partial, { force: true });
        throw new Error("断点文件与下载源不一致，已清除缓存，请重试");
      }
    }
    if (response.statusCode !== 200 && response.statusCode !== 206) throw new Error(`下载失败：HTTP ${response.statusCode}`);
    const resumed = offset > 0 && response.statusCode === 206;
    if (!resumed) offset = 0;
    const totalBytes = totalFromHeaders(response.headers, offset);
    const output = fs.createWriteStream(partial, { flags: resumed ? "a" : "w" });
    let downloadedBytes = offset;
    let lastAt = Date.now();
    let lastBytes = downloadedBytes;
    try {
      for await (const chunk of response.body) {
        if (!output.write(chunk)) await new Promise<void>((resolve) => output.once("drain", resolve));
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastAt >= 500) {
          const bytesPerSecond = Math.round((downloadedBytes - lastBytes) * 1000 / (now - lastAt));
          onProgress({ artifact: artifact.packageName, downloadedBytes, totalBytes, bytesPerSecond, resumed });
          lastAt = now;
          lastBytes = downloadedBytes;
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => error ? reject(error) : resolve()));
    }
    onProgress({ artifact: artifact.packageName, downloadedBytes, totalBytes, bytesPerSecond: 0, resumed });
    await verifyIntegrity(partial, artifact.integrity);
    await fsp.rename(partial, target);
    return target;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/body timeout|headers timeout/i.test(message)) throw new Error(`连续 ${config.inactivityTimeoutSeconds} 秒未收到下载数据，已保留进度供重试`);
    throw error;
  } finally {
    await dispatcher.close();
  }
}
