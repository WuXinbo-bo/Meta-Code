import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export function safeArchiveEntryPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) throw new Error(`压缩包包含非法路径：${value}`);
  const clean = path.posix.normalize(normalized);
  if (clean === ".." || clean.startsWith("../")) throw new Error(`压缩包路径越界：${value}`);
  return clean.replace(/\/$/, "");
}

function destinationPath(root: string, entryName: string) {
  const relative = safeArchiveEntryPath(entryName);
  const destination = path.resolve(root, ...relative.split("/"));
  const boundary = `${path.resolve(root)}${path.sep}`;
  if (destination !== path.resolve(root) && !destination.startsWith(boundary)) throw new Error(`压缩包路径越界：${entryName}`);
  return destination;
}

function zipEntryMode(entry: Entry) {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function zipEntryIsSymlink(entry: Entry) {
  return (zipEntryMode(entry) & 0xf000) === 0xa000;
}

function openZip(file: string) {
  return new Promise<ZipFile>((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => error || !zip ? reject(error || new Error("无法打开 ZIP")) : resolve(zip)));
}

function openZipEntry(zip: ZipFile, entry: Entry) {
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error || new Error("无法读取 ZIP 条目")) : resolve(stream)));
}

export async function extractZipSafely(file: string, destination: string) {
  await fsp.mkdir(destination, { recursive: true });
  const zip = await openZip(file);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      void (async () => {
        if (zipEntryIsSymlink(entry)) throw new Error(`ZIP 不允许符号链接：${entry.fileName}`);
        const target = destinationPath(destination, entry.fileName);
        if (/\/$/.test(entry.fileName)) await fsp.mkdir(target, { recursive: true });
        else {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          const stream = await openZipEntry(zip, entry);
          await pipeline(stream, fs.createWriteStream(target, { flags: "wx", mode: 0o755 }));
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

export async function extractTarSafely(file: string, destination: string) {
  const accepted = new Set<string>();
  await tar.t({
    file,
    strict: true,
    onentry: (entry) => {
      const relative = safeArchiveEntryPath(entry.path);
      if (["SymbolicLink", "Link"].includes(entry.type)) throw new Error(`TAR 不允许链接条目：${entry.path}`);
      destinationPath(destination, relative);
      accepted.add(relative);
    }
  });
  await fsp.mkdir(destination, { recursive: true });
  await tar.x({
    file,
    cwd: destination,
    strict: true,
    preservePaths: false,
    filter: (entryPath, entry) => {
      const relative = safeArchiveEntryPath(entryPath);
      return accepted.has(relative) && !("type" in entry && ["SymbolicLink", "Link"].includes(entry.type));
    }
  });
}

export function inferredArchiveKind(url: string): "zip" | "tar.gz" | "raw" {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".zip")) return "zip";
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar.gz";
  return "raw";
}
