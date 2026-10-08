import React from "react";
import { createRoot } from "react-dom/client";
import { AgentConversation, useAgentOutputFollow } from "/src/components/AgentConversation";
import { AgentDrawer } from "/src/components/AgentDrawer";
import "/src/styles.css";
import "/src/design/tokens.css";
import "/src/design/shell.css";
import "/src/design/conversation.css";

type FixtureState = { status: string; logs: unknown[]; surface?: "main" | "drawer"; filters?: boolean };
declare global {
  interface Window { renderActivityFixture: (state: FixtureState) => void }
}

function Fixture({ status, logs, surface = "main", filters = false }: FixtureState) {
  const follow = useAgentOutputFollow(JSON.stringify(logs), surface);
  const conversation = <AgentConversation logs={logs} status={status} provider="codex" showProvider={false} showFilters={filters} scrollRef={surface === "drawer" ? follow.containerRef : undefined} />;
  return surface === "drawer"
    ? <AgentDrawer title="日志折叠验证" onClose={() => {}} followOutput={follow} header={<header><strong>日志折叠验证</strong></header>}>{conversation}</AgentDrawer>
    : <main style={{ maxWidth: 760, margin: "24px auto", padding: "0 16px" }}>{conversation}</main>;
}

const root = createRoot(document.getElementById("root")!);
window.renderActivityFixture = (state) => root.render(<Fixture key={state.surface || "main"} {...state} />);
window.renderActivityFixture({ status: "completed", logs: [] });
