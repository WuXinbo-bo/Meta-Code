import fs from "node:fs";
import { runVerificationCommand, validateVerificationCommand } from "./enforcement.js";
import { withTransactionFileLock, writeJsonAtomically } from "./transactionFile.js";
import type { WorkflowNodeCheck } from "./types.js";

type CommandEntry = { command: string; phase: "started" | "running" | "completed" | "start_failed"; starts: number; check: WorkflowNodeCheck | null };
type WriterVerificationJournal = { schemaVersion: 1; identityDigest: string; commands: string[]; entries: CommandEntry[] };
export class WorkflowVerificationReplayError extends Error {
  override name = "WorkflowVerificationReplayError";
}

function invalidCommand(command: string) {
  try { validateVerificationCommand(command); return false; } catch { return true; }
}

function validEntry(entry: CommandEntry, command: string) {
  if (!entry || entry.command !== command || !["started", "running", "completed", "start_failed"].includes(entry.phase)
    || !Number.isInteger(entry.starts) || entry.starts < 1 || entry.starts > 2) return false;
  if (entry.phase === "started" || entry.phase === "running") return entry.check === null;
  const check = entry.check;
  if (!check || check.command !== command || typeof check.name !== "string" || typeof check.evidence !== "string"
    || !["passed", "failed"].includes(check.status)) return false;
  if (entry.phase === "start_failed") return check.status === "failed" && check.exitCode === null;
  if (check.exitCode === null) return check.status === "failed" && invalidCommand(command);
  return Number.isInteger(check.exitCode) && check.status === (check.exitCode === 0 ? "passed" : "failed");
}

/** Persist intent before spawning. A crash between spawn and durable exit evidence is never replayed. */
export async function runJournaledWriterVerification(input: {
  target: string; identityDigest: string; commands: string[]; cwd: string; signal: AbortSignal; ownerId: string;
  runner?: typeof runVerificationCommand;
}) {
  const { target, identityDigest, commands, cwd, signal, ownerId } = input;
  const readJournal = (): WriterVerificationJournal => {
    if (!fs.existsSync(target)) return { schemaVersion: 1, identityDigest, commands: [...commands], entries: [] };
    let journal: WriterVerificationJournal;
    try { journal = JSON.parse(fs.readFileSync(target, "utf8")); }
    catch { throw new WorkflowVerificationReplayError("写节点验收记录损坏，不能安全重放命令；请核对实际结果后显式重新执行"); }
    if (!journal || journal.schemaVersion !== 1 || journal.identityDigest !== identityDigest || JSON.stringify(journal.commands) !== JSON.stringify(commands) || !Array.isArray(journal.entries)
      || journal.entries.length > commands.length || journal.entries.some((entry, index) => !validEntry(entry, commands[index]))) {
      throw new WorkflowVerificationReplayError("写节点验收记录与合同不匹配，不能安全重放命令；请核对实际结果后显式重新执行");
    }
    return journal;
  };
  const persist = (journal: WriterVerificationJournal) => {
    try { writeJsonAtomically(target, journal); }
    catch { throw new WorkflowVerificationReplayError("无法持久化写节点验收记录，自动重放已停止；请核对实际结果后显式重新执行节点"); }
  };
  // Only hold the file lock while reading/claiming or committing a result. The
  // command may take minutes, so it must never run under the synchronous lock.
  const withJournal = <T>(operation: (journal: WriterVerificationJournal) => T) => {
    try { return withTransactionFileLock(target, () => operation(readJournal())); }
    catch (error) {
      if (error instanceof WorkflowVerificationReplayError) throw error;
      throw new WorkflowVerificationReplayError("无法安全读取或领取写节点验收命令，自动重放已停止；请核对实际结果后显式重新执行节点");
    }
  };
  const checks: WorkflowNodeCheck[] = [];
  let retryableStartFailure = false;
  let commandRunCount = 0;
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    signal.throwIfAborted();
    const entry = withJournal((journal): CommandEntry => {
      const previous = journal.entries[index];
      if (previous?.phase === "started" || previous?.phase === "running") throw new WorkflowVerificationReplayError("写节点系统验收在命令执行期间中断，不能确认命令是否已经产生副作用；请核对实际结果后显式重新执行节点");
      if (previous?.phase === "completed" || previous?.phase === "start_failed" && previous.starts >= 2) return previous;
      const claimed: CommandEntry = { command, phase: "started", starts: (previous?.starts || 0) + 1, check: null };
      journal.entries[index] = claimed;
      persist(journal);
      return claimed;
    });
    commandRunCount = Math.max(commandRunCount, entry.starts);
    if (entry.check) { checks.push(entry.check); continue; }
    const persistResult = () => withJournal((journal) => {
      const claimed = journal.entries[index];
      if (!claimed || claimed.phase !== "started" || claimed.starts !== entry.starts) {
        throw new WorkflowVerificationReplayError("写节点验收命令的领取记录已变化，不能覆盖当前证据；请核对实际结果后显式重新执行节点");
      }
      journal.entries[index] = entry;
      persist(journal);
    });
    try { validateVerificationCommand(command); }
    catch (error) {
      entry.phase = "completed";
      entry.check = { name: command, command, status: "failed", exitCode: null, evidence: error instanceof Error ? error.message : String(error) };
      persistResult();
      checks.push(entry.check);
      continue;
    }
    let didNotStart = false;
    let started = false;
    let check: WorkflowNodeCheck;
    try {
      check = await (input.runner || runVerificationCommand)(command, cwd, signal, ownerId, {
        onStarted: () => { started = true; }, onStartFailure: () => { if (!started) didNotStart = true; }
      });
    } catch {
      signal.throwIfAborted();
      throw new WorkflowVerificationReplayError("写节点验收命令异常中断，不能确认执行结果；请核对实际结果后显式重新执行节点");
    }
    if (didNotStart) {
      entry.phase = "start_failed";
      entry.check = check;
      retryableStartFailure ||= entry.starts < 2;
    } else if (check.exitCode !== null && Number.isInteger(check.exitCode)) {
      entry.phase = "completed";
      entry.check = check;
    } else {
      // A timeout, cancellation, signal exit or unknown transport result cannot
      // prove the command had no side effects. Preserve the started marker.
      signal.throwIfAborted();
      throw new WorkflowVerificationReplayError("写节点验收命令没有确定退出结果，可能已产生副作用；自动重放已停止，请核对实际结果后显式重新执行节点");
    }
    if (!validEntry(entry, command)) throw new WorkflowVerificationReplayError("写节点验收返回了无效退出证据，不能安全重放命令；请核对实际结果后显式重新执行节点");
    persistResult();
    signal.throwIfAborted();
    checks.push(check);
  }
  return { checks, retryableStartFailure, commandRunCount };
}
