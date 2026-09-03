import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import type { AppUpdateChannel, AppUpdateConfig } from "./types.js";

const releaseConfigSchema = z.object({
  schemaVersion: z.literal(2),
  productId: z.string().min(1),
  productName: z.string().min(1),
  dataSchemaVersion: z.number().int().positive(),
  dataCompatibility: z.object({
    readsFrom: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
    writesTo: z.number().int().positive(),
    migratesFrom: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
    migrationProtocolVersion: z.number().int().positive(),
    downgradePolicy: z.literal("blocked")
  }),
  launcherProtocol: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
  manifestSigning: z.object({ required: z.literal(true), trustedKeys: z.record(z.string(), z.string().min(1)) }),
  githubRepository: z.string(),
  manifestUrls: z.object({ stable: z.string(), beta: z.string() }),
  defaultChannel: z.enum(["stable", "beta"]),
  defaultCheckIntervalHours: z.number().min(1).max(168)
});

const packageSchema = z.object({ version: z.string().min(1).refine((value) => Boolean(semver.valid(value)), "package.json version 必须是有效的 SemVer") });

function envValue(name: string, fallback: string) {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

export function loadAppUpdateConfig(projectRoot: string): AppUpdateConfig {
  const releasePath = path.join(projectRoot, "release.config.json");
  const packagePath = path.join(projectRoot, "package.json");
  const release = releaseConfigSchema.parse(JSON.parse(fs.readFileSync(releasePath, "utf8")));
  const packageJson = packageSchema.parse(JSON.parse(fs.readFileSync(packagePath, "utf8")));
  const sharedManifest = envValue("METACODE_UPDATE_MANIFEST_URL", "");
  const defaultChannel = (envValue("METACODE_UPDATE_CHANNEL", release.defaultChannel) || release.defaultChannel) as AppUpdateChannel;
  if (defaultChannel !== "stable" && defaultChannel !== "beta") throw new Error("METACODE_UPDATE_CHANNEL 只能是 stable 或 beta");
  let currentBuildId = "development";
  try {
    const buildInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, "build-info.json"), "utf8")) as { buildId?: unknown };
    if (typeof buildInfo.buildId === "string" && buildInfo.buildId.trim()) currentBuildId = buildInfo.buildId.trim();
  } catch { /* Development checkouts intentionally have no immutable build identity. */ }
  if (release.dataCompatibility.writesTo !== release.dataSchemaVersion) throw new Error("dataCompatibility.writesTo 必须等于 dataSchemaVersion");
  for (const range of [release.dataCompatibility.readsFrom, release.dataCompatibility.migratesFrom, release.launcherProtocol]) {
    if (range.min > range.max) throw new Error("发布兼容范围无效");
  }
  return {
    ...release,
    currentVersion: packageJson.version,
    githubRepository: envValue("METACODE_GITHUB_REPOSITORY", release.githubRepository),
    manifestUrls: {
      stable: envValue("METACODE_UPDATE_MANIFEST_STABLE_URL", sharedManifest || release.manifestUrls.stable),
      beta: envValue("METACODE_UPDATE_MANIFEST_BETA_URL", sharedManifest || release.manifestUrls.beta)
    },
    defaultChannel,
    currentBuildId
  };
}
