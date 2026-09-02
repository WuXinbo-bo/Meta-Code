import { markdownRenderPlan } from "./markdownPlan";
import { isMarkdownWorkerRequest, type MarkdownWorkerRequest, type MarkdownWorkerResponse } from "./markdownWorkerProtocol";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<MarkdownWorkerRequest>) => void): void;
  postMessage(message: MarkdownWorkerResponse): void;
};

const workerScope = self as unknown as WorkerScope;
const scheduled = new Map<number, ReturnType<typeof setTimeout>>();

workerScope.addEventListener("message", (event) => {
  if (!isMarkdownWorkerRequest(event.data)) return;

  if (event.data.type === "cancel") {
    const timer = scheduled.get(event.data.id);
    if (timer !== undefined) clearTimeout(timer);
    scheduled.delete(event.data.id);
    return;
  }

  const { id, source } = event.data;
  const previousTimer = scheduled.get(id);
  if (previousTimer !== undefined) clearTimeout(previousTimer);

  const timer = setTimeout(() => {
    scheduled.delete(id);
    try {
      workerScope.postMessage({ type: "planned", id, plan: markdownRenderPlan(source) });
    } catch (error) {
      workerScope.postMessage({
        type: "failed",
        id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, 0);
  scheduled.set(id, timer);
});
