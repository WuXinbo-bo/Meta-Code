const PROVIDER_ACCENTS: Record<string, string> = {
  gemini: "#4285f4",
  "github-copilot-cli": "#8957e5",
  "grok-build": "#4f6b82",
  "qwen-code": "#615ced",
  kimi: "#5865f2",
  opencode: "#f97316",
  "mistral-vibe": "#ff7000",
  goose: "#d97706",
  cline: "#e5534b",
  kilo: "#2563eb",
  "glm-acp-agent": "#2563eb",
  cursor: "#6b7280",
  "factory-droid": "#4f46e5"
  , "deepseek-harness": "#4d6bfe"
};

const FALLBACK_ACCENTS = ["#2563eb", "#7c3aed", "#0891b2", "#0f766e", "#c2410c", "#be123c"];

export function providerBrandAccent(providerId: string) {
  const id = String(providerId || "").trim().toLowerCase();
  if (PROVIDER_ACCENTS[id]) return PROVIDER_ACCENTS[id];
  let hash = 0;
  for (const character of id) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return FALLBACK_ACCENTS[Math.abs(hash) % FALLBACK_ACCENTS.length];
}
