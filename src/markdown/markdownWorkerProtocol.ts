import { isMarkdownRenderPlan, type MarkdownRenderPlan } from "./markdownPlan";

export type MarkdownWorkerRequest =
  | { type: "plan"; id: number; source: string }
  | { type: "cancel"; id: number };

export type MarkdownWorkerResponse =
  | { type: "planned"; id: number; plan: MarkdownRenderPlan }
  | { type: "failed"; id: number; error: string };

export function isMarkdownWorkerRequest(value: unknown): value is MarkdownWorkerRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<MarkdownWorkerRequest>;
  if (!Number.isSafeInteger(request.id) || request.id! < 0) return false;
  if (request.type === "cancel") return true;
  return request.type === "plan" && typeof request.source === "string";
}

export function isMarkdownWorkerResponse(value: unknown): value is MarkdownWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<MarkdownWorkerResponse>;
  if (!Number.isSafeInteger(response.id) || response.id! < 0) return false;
  if (response.type === "failed") return typeof response.error === "string";
  return response.type === "planned" && isMarkdownRenderPlan(response.plan);
}
