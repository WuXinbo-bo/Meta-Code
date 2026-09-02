import claudeIcon from "../assets/brands/claude.svg";
import openaiIcon from "../assets/brands/openai.svg";
import { useEffect, useState } from "react";

export type ProviderName = string;

const LOCAL_ICONS: Record<string, string> = { claude: claudeIcon, codex: openaiIcon, openai: openaiIcon };

function initials(provider: string) {
  return provider.split(/[-_.\s]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "AI";
}

export function ProviderIcon({ provider, icon = "", accent = "", size = 18, className = "" }: { provider: ProviderName; icon?: string; accent?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [provider, icon]);
  const classes = `provider-brand-icon ${provider} ${className}`.trim();
  const source = LOCAL_ICONS[provider] || LOCAL_ICONS[icon] || (/^https:\/\//i.test(icon) ? icon : "");
  if (source && !failed && /^https:\/\//i.test(source) && accent) return <span className={`${classes} provider-brand-mask`} style={{ width: size, height: size, backgroundColor: accent, WebkitMaskImage: `url("${source}")`, maskImage: `url("${source}")` }} aria-hidden="true" />;
  if (source && !failed) return <img className={classes} src={source} width={size} height={size} alt="" aria-hidden="true" onError={() => setFailed(true)} />;
  return <span className={`${classes} provider-brand-monogram`} style={{ width: size, height: size, color: accent || undefined }} aria-hidden="true">{initials(provider)}</span>;
}
