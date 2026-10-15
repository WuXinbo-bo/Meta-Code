import { randomUUID } from "node:crypto";
import { cp } from "node:fs/promises";
import { copySessionAttachments } from "../attachments.js";
import { CodexAppServerClient } from "../codexLink/appServerClient.js";
import type { Session, Workspace } from "../workbench/types.js";
import type { CodexNativeSession } from "./codex/appServerSession.js";
import { DEFAULT_NATIVE_OPTIONS } from "./nativeInteraction.js";

/** Prepare independent native history before publishing the new task. Claude
 * materializes its official fork on the first turn; its pending ID cannot fork. */
export async function prepareNativeFork(source: Session, workspace: Workspace, host: {
  title: string;
  ensureRoot: (session: Session) => Promise<Workspace>;
  codexLaunch: (session: Session, workspace: Workspace) => Promise<ConstructorParameters<typeof CodexNativeSession>[0]>;
}) {
  const now = new Date().toISOString();
  const branch: Session = {
    ...source, id: `task_${randomUUID()}`, title: host.title, createdAt: now, updatedAt: now,
    revision: 1, status: "idle", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    pendingInputs: [], parentSessionId: source.id,
    messages: source.messages.map(m => ({ ...m, id: `msg_${randomUUID()}`, sourceId: undefined })),
    runStartedAt: undefined, runFinishedAt: undefined, lastError: undefined, stopReason: undefined,
    deadlineAt: undefined, creationMutationId: undefined, branchedFromMessageId: undefined,
    pinned: false, archivedAt: null, codexThreadId: null,
    engineSessionId: source.engine === "claude" ? randomUUID() : null,
    nativeOptions: { ...(source.nativeOptions || DEFAULT_NATIVE_OPTIONS) }
  };
  let branchWorkspace = workspace;
  if (source.scopeKind === "standalone") {
    branchWorkspace = await host.ensureRoot(branch);
    await cp(workspace.root, branchWorkspace.root, { recursive: true, force: false });
  }
  for (const message of branch.messages) if (message.attachments?.length) {
    message.attachments = await copySessionAttachments(workspace.root, source.id, branchWorkspace.root, branch.id, message.attachments);
  }
  if (source.engine === "codex") {
    const launch = await host.codexLaunch(source, branchWorkspace);
    const client = new CodexAppServerClient(launch.executable, launch.home, undefined, {
      args: launch.args, env: launch.env, cwd: launch.cwd, experimental: true
    });
    try {
      const result = await client.request("thread/fork", {
        ...launch.thread, threadId: source.codexThreadId || source.engineSessionId, excludeTurns: true
      }, 60_000) as { thread?: { id?: string } };
      if (!result.thread?.id || result.thread.id === source.engineSessionId) throw new Error("官方 CLI 没有创建独立原生分支");
      branch.codexThreadId = branch.engineSessionId = result.thread.id;
    } finally { client.close(); }
  } else branch.nativeForkSourceId = source.engineSessionId!;
  return { branch, branchWorkspace };
}
