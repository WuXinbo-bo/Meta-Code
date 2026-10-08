import fs from "node:fs";
import path from "node:path";

export type WorkspaceExecutionRequest = {
  root: string;
  ownerId: string;
  label: string;
  access: "read" | "write";
};

export type WorkspaceExecutionLease = WorkspaceExecutionRequest & { release: () => void };

function canonicalRoot(root: string) {
  const resolved = path.resolve(root);
  let existing = resolved;
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  let canonical: string;
  try { canonical = path.join(fs.realpathSync.native(existing), ...suffix); }
  catch { canonical = resolved; }
  return process.platform === "win32" || process.platform === "darwin" ? canonical.toLowerCase() : canonical;
}

function rootsOverlap(left: string, right: string) {
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return !relative || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
  };
  return within(left, right) || within(right, left);
}

/** Coordinates project writers while allowing a parent and its delegated work to share ownership. */
export class WorkspaceExecutionCoordinator {
  private active = new Set<WorkspaceExecutionLease>();
  private pending: Array<{
    request: WorkspaceExecutionRequest;
    resolve: (lease: WorkspaceExecutionLease) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private listeners = new Set<() => void>();

  private normalize(input: WorkspaceExecutionRequest): WorkspaceExecutionRequest {
    if (!input.root || !input.ownerId) throw new Error("工作区执行缺少目录或任务身份");
    return { ...input, root: canonicalRoot(input.root) };
  }

  private conflicts(left: WorkspaceExecutionRequest, right: WorkspaceExecutionRequest) {
    return left.ownerId !== right.ownerId && (left.access === "write" || right.access === "write") && rootsOverlap(left.root, right.root);
  }

  private available(request: WorkspaceExecutionRequest, queueIndex = this.pending.length) {
    if ([...this.active].some((lease) => this.conflicts(request, lease))) return false;
    const nested = [...this.active].some((lease) => lease.ownerId === request.ownerId && rootsOverlap(lease.root, request.root));
    return nested || !this.pending.slice(0, queueIndex).some((pending) => this.conflicts(request, pending.request));
  }

  private grant(request: WorkspaceExecutionRequest): WorkspaceExecutionLease {
    let released = false;
    const lease = { ...request, release: () => {
      if (released) return;
      released = true;
      this.active.delete(lease);
      this.flush();
      for (const listener of this.listeners) listener();
    } };
    this.active.add(lease);
    return lease;
  }

  tryAcquire(input: WorkspaceExecutionRequest): WorkspaceExecutionLease | null {
    const request = this.normalize(input);
    return this.available(request) ? this.grant(request) : null;
  }

  acquire(input: WorkspaceExecutionRequest, options: { signal?: AbortSignal } = {}): Promise<WorkspaceExecutionLease> {
    const request = this.normalize(input);
    if (options.signal?.aborted) return Promise.reject(options.signal.reason || new Error("工作区执行已取消"));
    if (this.available(request)) return Promise.resolve(this.grant(request));
    return new Promise((resolve, reject) => {
      const pending = { request, resolve, reject, signal: options.signal, onAbort: undefined as (() => void) | undefined };
      pending.onAbort = () => {
        this.pending = this.pending.filter((item) => item !== pending);
        reject(options.signal?.reason || new Error("工作区执行已取消"));
        this.flush();
      };
      options.signal?.addEventListener("abort", pending.onAbort, { once: true });
      this.pending.push(pending);
    });
  }

  private flush() {
    for (let index = 0; index < this.pending.length;) {
      const pending = this.pending[index];
      if (!this.available(pending.request, index)) { index += 1; continue; }
      this.pending.splice(index, 1);
      if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.resolve(this.grant(pending.request));
    }
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot() {
    return { active: [...this.active].map(({ release: _release, ...request }) => request), waiting: this.pending.map(({ request }) => request) };
  }
}

export const workspaceExecutionCoordinator = new WorkspaceExecutionCoordinator();
