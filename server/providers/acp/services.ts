import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertPathInsideRoot } from "../../pathBoundary.js";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest
} from "@agentclientprotocol/sdk";

export type AcpClientServices = {
  capabilities: { readTextFile: boolean; writeTextFile: boolean; terminal: boolean };
  requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  readTextFile(request: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(request: WriteTextFileRequest): Promise<void>;
  createTerminal(request: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  terminalOutput(request: TerminalOutputRequest): Promise<TerminalOutputResponse>;
  waitForTerminalExit(request: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
  killTerminal(request: KillTerminalRequest): Promise<void>;
  releaseTerminal(request: ReleaseTerminalRequest): Promise<void>;
  close(): Promise<void>;
};

export type RestrictedAcpClientServicesOptions = {
  roots: string[];
  allowWrite: boolean;
  allowTerminal: boolean;
  autoApprove?: boolean;
  permission?: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
  maxTerminalOutputBytes?: number;
};

type TerminalRecord = {
  child: ChildProcessWithoutNullStreams;
  output: string;
  outputLimit: number;
  truncated: boolean;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  exited: Promise<{ exitCode: number | null; signal: string | null }>;
};

export class RestrictedAcpClientServices implements AcpClientServices {
  readonly capabilities;
  private readonly roots: string[];
  private readonly terminals = new Map<string, TerminalRecord>();
  private terminalSequence = 0;

  constructor(private readonly options: RestrictedAcpClientServicesOptions) {
    this.roots = options.roots.map((root) => path.resolve(root));
    if (!this.roots.length) throw new Error("ACP Client 至少需要一个工作区根目录");
    this.capabilities = { readTextFile: true, writeTextFile: options.allowWrite, terminal: options.allowTerminal };
  }

  async requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (this.options.permission) return this.options.permission(request, signal);
    const preferredKind = this.options.autoApprove ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    const option = request.options.find((item) => preferredKind.includes(item.kind));
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  async readTextFile(request: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const target = this.assertPath(request.path);
    const content = await fsp.readFile(target, "utf8");
    if (!request.line && !request.limit) return { content };
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, Math.floor(request.line || 1) - 1);
    const limit = Math.min(100_000, Math.max(0, Math.floor(request.limit || lines.length)));
    return { content: lines.slice(start, start + limit).join("\n") };
  }

  async writeTextFile(request: WriteTextFileRequest): Promise<void> {
    if (!this.options.allowWrite) throw new Error("ACP Client 当前为只读模式");
    const target = this.assertPath(request.path, true);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, request.content, "utf8");
  }

  async createTerminal(request: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    if (!this.options.allowTerminal) throw new Error("ACP Client 当前未开放终端能力");
    const cwd = this.assertPath(request.cwd || this.roots[0]);
    const outputLimit = Math.min(
      Math.max(1_024, request.outputByteLimit || this.options.maxTerminalOutputBytes || 1_048_576),
      this.options.maxTerminalOutputBytes || 4_194_304
    );
    const env = { ...process.env };
    for (const item of request.env || []) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name)) env[item.name] = item.value;
    const child = spawn(request.command, request.args || [], { cwd, env, shell: false, windowsHide: true });
    const terminalId = `acp-terminal-${++this.terminalSequence}`;
    let resolveExit!: (status: { exitCode: number | null; signal: string | null }) => void;
    const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => { resolveExit = resolve; });
    const record: TerminalRecord = { child, output: "", outputLimit, truncated: false, exitStatus: null, exited };
    const append = (chunk: Buffer) => {
      record.output += chunk.toString("utf8");
      const trimmed = trimUtf8Tail(record.output, record.outputLimit);
      record.truncated ||= trimmed.length !== record.output.length;
      record.output = trimmed;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => append(Buffer.from(`\n${error.message}`)));
    child.once("exit", (exitCode, signal) => {
      record.exitStatus = { exitCode, signal };
      resolveExit(record.exitStatus);
    });
    this.terminals.set(terminalId, record);
    return { terminalId };
  }

  async terminalOutput(request: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const record = this.requireTerminal(request.terminalId);
    return { output: record.output, truncated: record.truncated, ...(record.exitStatus ? { exitStatus: record.exitStatus } : {}) };
  }

  async waitForTerminalExit(request: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    return this.requireTerminal(request.terminalId).exited;
  }

  async killTerminal(request: KillTerminalRequest): Promise<void> {
    const record = this.requireTerminal(request.terminalId);
    if (!record.exitStatus) record.child.kill();
  }

  async releaseTerminal(request: ReleaseTerminalRequest): Promise<void> {
    const record = this.requireTerminal(request.terminalId);
    if (!record.exitStatus) record.child.kill();
    this.terminals.delete(request.terminalId);
  }

  async close() {
    for (const [terminalId] of this.terminals) await this.releaseTerminal({ sessionId: "closing", terminalId });
  }

  private assertPath(input: string, allowMissing = false) {
    if (!path.isAbsolute(input)) throw new Error("ACP 文件和终端路径必须是绝对路径");
    const target = path.resolve(input);
    if (!this.roots.some((root) => {
      try { assertPathInsideRoot(root, target, { allowMissing }); return true; }
      catch { return false; }
    })) throw new Error(`ACP 请求越过工作区边界：${target}`);
    return target;
  }

  private requireTerminal(terminalId: string) {
    const record = this.terminals.get(terminalId);
    if (!record) throw new Error(`ACP 终端不存在：${terminalId}`);
    return record;
  }
}

function trimUtf8Tail(value: string, byteLimit: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= byteLimit) return value;
  let start = bytes.byteLength - byteLimit;
  while (start < bytes.byteLength && (bytes[start] & 0b1100_0000) === 0b1000_0000) start += 1;
  return bytes.subarray(start).toString("utf8");
}
