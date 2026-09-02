import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type WorkbenchSecrets = {
  codexApiKey: string;
  claudeApiKey: string;
  mcp: Record<string, { env: Record<string, string>; headers: Record<string, string> }>;
  providerConnections: Record<string, { apiKey: string; secretEnv: Record<string, string> }>;
};

type StoredEnvelope = {
  version: 1;
  protection: "dpapi-current-user" | "aes-256-gcm";
  payload: string;
  iv?: string;
  tag?: string;
};

const EMPTY_SECRETS: WorkbenchSecrets = { codexApiKey: "", claudeApiKey: "", mcp: {}, providerConnections: {} };

function powershellDpapi(operation: "protect" | "unprotect", payload: Buffer) {
  const method = operation === "protect" ? "Protect" : "Unprotect";
  const script = `Add-Type -AssemblyName System.Security;$raw=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($raw);$out=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: payload.toString("base64"), encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024
  });
  return Buffer.from(output.trim(), "base64");
}

function safeSecrets(value: unknown): WorkbenchSecrets {
  const source = value && typeof value === "object" ? value as Partial<WorkbenchSecrets> : {};
  const mcp: WorkbenchSecrets["mcp"] = {};
  if (source.mcp && typeof source.mcp === "object") {
    for (const [id, entry] of Object.entries(source.mcp)) {
      if (!entry || typeof entry !== "object") continue;
      const clean = (input: unknown) => Object.fromEntries(Object.entries(input && typeof input === "object" ? input : {}).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
      mcp[id] = { env: clean(entry.env), headers: clean(entry.headers) };
    }
  }
  const providerConnections: WorkbenchSecrets["providerConnections"] = {};
  if (source.providerConnections && typeof source.providerConnections === "object") {
    for (const [id, entry] of Object.entries(source.providerConnections)) {
      if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(id) || !entry || typeof entry !== "object") continue;
      const secretEnv = Object.fromEntries(Object.entries("secretEnv" in entry && entry.secretEnv && typeof entry.secretEnv === "object" ? entry.secretEnv : {}).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
      providerConnections[id] = { apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "", secretEnv };
    }
  }
  return {
    codexApiKey: typeof source.codexApiKey === "string" ? source.codexApiKey : "",
    claudeApiKey: typeof source.claudeApiKey === "string" ? source.claudeApiKey : "",
    mcp,
    providerConnections
  };
}

export class SecretVault {
  private current: WorkbenchSecrets | null = null;

  constructor(private readonly file: string, private readonly forcePortable = false) {}

  private keyFile() {
    return `${this.file}.key`;
  }

  private portableKey() {
    const keyFile = this.keyFile();
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    }
    const key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw new Error("工作台凭据密钥文件无效");
    return key;
  }

  load() {
    if (this.current) return structuredClone(this.current);
    if (!fs.existsSync(this.file)) {
      this.current = structuredClone(EMPTY_SECRETS);
      return structuredClone(this.current);
    }
    const envelope = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredEnvelope;
    let clear: Buffer;
    if (envelope.protection === "dpapi-current-user") {
      if (process.platform !== "win32") throw new Error("DPAPI 凭据只能由创建它的 Windows 用户读取");
      clear = powershellDpapi("unprotect", Buffer.from(envelope.payload, "base64"));
    } else if (envelope.protection === "aes-256-gcm" && envelope.iv && envelope.tag) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.portableKey(), Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      clear = Buffer.concat([decipher.update(Buffer.from(envelope.payload, "base64")), decipher.final()]);
    } else throw new Error("工作台凭据文件格式不受支持");
    this.current = safeSecrets(JSON.parse(clear.toString("utf8")));
    clear.fill(0);
    return structuredClone(this.current);
  }

  save(next: WorkbenchSecrets) {
    const normalized = safeSecrets(next);
    if (this.current && JSON.stringify(this.current) === JSON.stringify(normalized) && fs.existsSync(this.file)) return false;
    const clear = Buffer.from(JSON.stringify(normalized), "utf8");
    let envelope: StoredEnvelope;
    if (process.platform === "win32" && !this.forcePortable) {
      try {
        envelope = { version: 1, protection: "dpapi-current-user", payload: powershellDpapi("protect", clear).toString("base64") };
      } catch {
        envelope = this.encryptPortable(clear);
      }
    } else {
      envelope = this.encryptPortable(clear);
    }
    clear.fill(0);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.current = normalized;
    return true;
  }

  private encryptPortable(clear: Buffer): StoredEnvelope {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.portableKey(), iv);
      const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
      return { version: 1, protection: "aes-256-gcm", payload: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }
}
