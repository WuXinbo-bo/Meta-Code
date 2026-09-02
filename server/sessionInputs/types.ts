export type PendingInputMode = "queue" | "steer";
export type PendingInputStatus = "queued" | "steering";

export type PendingInput<TAttachment = unknown, TSkillPolicies = Record<string, unknown>> = {
  schemaVersion: 1;
  id: string;
  text: string;
  mode: PendingInputMode;
  status: PendingInputStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
  skillName?: string;
  skillNames?: string[];
  agentMode?: "auto" | "all" | "off";
  skillPolicies?: TSkillPolicies;
  attachments?: TAttachment[];
};

export type PendingInputPatch<TAttachment = unknown> = {
  text?: string;
  attachments?: TAttachment[];
  skillNames?: string[];
};

export type PendingInputActionErrorCode = "not_found" | "locked" | "invalid";

export class PendingInputActionError extends Error {
  constructor(
    public readonly code: PendingInputActionErrorCode,
    message: string
  ) {
    super(message);
  }
}
