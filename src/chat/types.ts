export type EngineName = string;
export type ExecutionMode = "native" | "collaborative";

export type ModelOption = {
  id: string;
  displayName: string;
  createdAt?: string;
};

export type PendingTurn<TAttachment = unknown> = {
  schemaVersion?: 1;
  id: string;
  text: string;
  mode: "queue" | "steer";
  status?: "queued" | "steering";
  createdAt: string;
  updatedAt?: string;
  revision?: number;
  clientMutationId?: string;
  skillNames?: string[];
  attachments?: TAttachment[];
};

export type CapabilityProfileSummary = {
  id: string;
  name: string;
  description: string;
};

export type AcpConfigChoice = {
  value: string;
  name: string;
  description?: string | null;
};

export type AcpConfigOption = {
  type: "select" | "boolean";
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  currentValue: string | boolean;
  options?: Array<AcpConfigChoice | { group: string; name: string; options: AcpConfigChoice[] }>;
};

export type ProviderSessionConfiguration = {
  schemaVersion: 1;
  providerId: string;
  transport: "native" | "acp";
  options: AcpConfigOption[];
  values?: Record<string, string | boolean>;
};
