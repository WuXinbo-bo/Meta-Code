/** Claude's result ends one model turn, not necessarily its background work. */
export class ClaudeBackgroundTasks {
  private readonly tasks = new Map<string, { ambient: boolean }>();

  get activeCount() { return [...this.tasks.values()].filter((task) => !task.ambient).length; }

  apply(item: Record<string, any>) {
    if (item.subtype === "background_tasks_changed" && Array.isArray(item.tasks)) {
      this.tasks.clear();
      for (const task of item.tasks) {
        if (typeof task?.task_id === "string") this.tasks.set(task.task_id, { ambient: task.ambient === true });
      }
      return;
    }
    const id = typeof item.task_id === "string" ? item.task_id : "";
    if (!id) return;
    if (item.subtype === "task_started" && item.owned_by_subagent !== true) this.tasks.set(id, { ambient: item.ambient === true });
    // A status patch precedes the notification consumed by the model. Keep
    // the task until that notification (or the next authoritative snapshot).
    if (item.subtype === "task_notification") this.tasks.delete(id);
  }

  mustWait(result: Record<string, any>) {
    return this.activeCount > 0 || Number(result.queued_turn_count || 0) > 0;
  }
}

export type ClaudeInputOrigin = "human" | "auto-continuation";

export function claudeUserInput(text: string, origin?: ClaudeInputOrigin) {
  return {
    type: "user", parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text }] },
    ...(origin ? { origin: { kind: origin } } : {})
  };
}
