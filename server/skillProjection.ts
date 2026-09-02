import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type SkillProjectionEngine = string;
export type SkillProjectionTarget = { providerId: string; workspacePath: string };

const DEFAULT_PROJECTION_TARGETS: SkillProjectionTarget[] = [
  { providerId: "codex", workspacePath: ".agents/skills" },
  { providerId: "claude", workspacePath: ".claude/skills" }
];

type WorkspaceProjection = {
  root: string;
  base: Set<string>;
  leases: Map<string, Set<string>>;
};

const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function samePath(left: string, right: string) {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function isInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function projectionRoots(workspaceRoot: string, targets: SkillProjectionTarget[]) {
  return Object.fromEntries(targets.map((target) => [target.providerId, path.resolve(workspaceRoot, target.workspacePath)])) as Record<SkillProjectionEngine, string>;
}

const EXCLUDE_START = "# BEGIN Claude-Codex Workbench Skill Projections";
const EXCLUDE_END = "# END Claude-Codex Workbench Skill Projections";

function gitMetadata(workspaceRoot: string) {
  let current = path.resolve(workspaceRoot);
  while (true) {
    const marker = path.join(current, ".git");
    try {
      const stat = fs.statSync(marker);
      if (stat.isDirectory()) return { root: current, gitDir: marker };
      if (stat.isFile()) {
        const value = fs.readFileSync(marker, "utf8").match(/^gitdir:\s*(.+)\s*$/mi)?.[1]?.trim();
        if (value) return { root: current, gitDir: path.resolve(current, value) };
      }
    } catch { /* Continue to the parent directory. */ }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function updateGitExclude(workspaceRoot: string, projectedPaths: string[]) {
  const metadata = gitMetadata(workspaceRoot);
  if (!metadata) return;
  const excludeFile = path.join(metadata.gitDir, "info", "exclude");
  try {
    const workspaceKey = crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
    const blockStart = `${EXCLUDE_START} ${workspaceKey}`;
    const blockEnd = `${EXCLUDE_END} ${workspaceKey}`;
    const previous = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
    const blockPattern = new RegExp(`${blockStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${blockEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n?`, "g");
    const retained = previous.replace(blockPattern, "").trimEnd();
    const patterns = projectedPaths.map((projectedPath) => {
      const relative = path.relative(metadata.root, projectedPath).replace(/\\/g, "/");
      return `/${relative}`;
    }).sort();
    const next = [retained, patterns.length ? [blockStart, ...patterns, blockEnd].join("\n") : ""]
      .filter(Boolean).join("\n\n");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.writeFileSync(excludeFile, next ? `${next}\n` : "", "utf8");
  } catch { /* Git metadata is optional; projection still works without it. */ }
}

function readLinkTarget(destination: string) {
  try {
    if (!fs.lstatSync(destination).isSymbolicLink()) return "";
    const target = fs.readlinkSync(destination);
    return path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(destination), target);
  } catch {
    return "";
  }
}

export class WorkspaceSkillProjectionManager {
  private readonly workspaces = new Map<string, WorkspaceProjection>();
  private readonly targets: SkillProjectionTarget[];

  constructor(private readonly managedRoot: string, targets: SkillProjectionTarget[] = DEFAULT_PROJECTION_TARGETS) {
    this.targets = targets.map((target) => {
      const providerId = String(target.providerId || "").trim().toLowerCase();
      const workspacePath = String(target.workspacePath || "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(providerId)) throw new Error(`Skill 投影 Provider ID 无效：${providerId}`);
      if (!workspacePath || path.isAbsolute(workspacePath) || workspacePath.split("/").includes("..")) throw new Error(`Skill 投影目录必须是工作区内的相对路径：${workspacePath}`);
      return { providerId, workspacePath };
    });
  }

  private safeName(name: string) {
    const normalized = String(name || "").trim();
    if (!SAFE_SKILL_NAME.test(normalized)) throw new Error(`Skill 名称格式无效：${normalized}`);
    return normalized;
  }

  private managedSkillRoot(name: string) {
    const target = path.join(this.managedRoot, this.safeName(name));
    if (!isInside(this.managedRoot, target) || !fs.existsSync(path.join(target, "SKILL.md"))) return "";
    return target;
  }

  private workspaceState(workspaceId: string, workspaceRoot: string) {
    const current = this.workspaces.get(workspaceId);
    if (current && samePath(current.root, workspaceRoot)) return current;
    const next: WorkspaceProjection = { root: path.resolve(workspaceRoot), base: new Set(), leases: new Map() };
    this.workspaces.set(workspaceId, next);
    return next;
  }

  private desiredSkills(state: WorkspaceProjection) {
    const desired = new Set(state.base);
    for (const names of state.leases.values()) for (const name of names) desired.add(name);
    return desired;
  }

  private removeManagedLink(destination: string) {
    const target = readLinkTarget(destination);
    if (!target || !isInside(this.managedRoot, target)) return;
    try { fs.unlinkSync(destination); } catch { /* A compatibility prompt remains available. */ }
  }

  private ensureLink(destination: string, target: string) {
    const existingTarget = readLinkTarget(destination);
    if (existingTarget) return samePath(existingTarget, target);
    if (fs.existsSync(destination)) return false;
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
      return true;
    } catch {
      return false;
    }
  }

  private reconcile(state: WorkspaceProjection) {
    try {
      if (!fs.statSync(state.root).isDirectory()) return;
    } catch {
      return;
    }
    const desired = this.desiredSkills(state);
    const roots = projectionRoots(state.root, this.targets);
    const projectedPaths: string[] = [];
    for (const root of Object.values(roots)) {
      try {
        if (fs.existsSync(root)) {
          for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!desired.has(entry.name)) this.removeManagedLink(path.join(root, entry.name));
          }
        }
        for (const name of desired) {
          const target = this.managedSkillRoot(name);
          const destination = path.join(root, name);
          if (target && this.ensureLink(destination, target) && isInside(this.managedRoot, readLinkTarget(destination))) projectedPaths.push(destination);
        }
        try { fs.rmdirSync(root); } catch { /* Keep non-empty or user-owned directories. */ }
        try { fs.rmdirSync(path.dirname(root)); } catch { /* Keep non-empty or user-owned directories. */ }
      } catch { /* Prompt injection remains the compatibility path. */ }
    }
    updateGitExclude(state.root, projectedPaths);
  }

  setBaseSkills(workspaceId: string, workspaceRoot: string, names: Iterable<string>) {
    const state = this.workspaceState(workspaceId, workspaceRoot);
    state.base = new Set([...names].map((name) => this.safeName(name)));
    this.reconcile(state);
  }

  acquireTemporarySkills(workspaceId: string, workspaceRoot: string, names: Iterable<string>) {
    const state = this.workspaceState(workspaceId, workspaceRoot);
    const leaseId = crypto.randomUUID();
    const selected = new Set([...names].map((name) => this.safeName(name)));
    if (selected.size) state.leases.set(leaseId, selected);
    this.reconcile(state);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.leases.delete(leaseId);
      this.reconcile(state);
    };
  }

  isAvailable(workspaceRoot: string, engine: SkillProjectionEngine, name: string) {
    const managed = this.managedSkillRoot(name);
    if (!managed) return false;
    const root = projectionRoots(workspaceRoot, this.targets)[engine];
    if (!root) return false;
    const destination = path.join(root, this.safeName(name));
    const linked = readLinkTarget(destination);
    if (linked) return samePath(linked, managed);
    try {
      const projectedInstructions = fs.readFileSync(path.join(destination, "SKILL.md"), "utf8");
      const managedInstructions = fs.readFileSync(path.join(managed, "SKILL.md"), "utf8");
      return projectedInstructions === managedInstructions;
    } catch {
      return false;
    }
  }
}
