import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkflowAgentDrawer } from "/src/workflow/WorkflowAgentDrawer";
import "/src/styles.css";
import "/src/design/tokens.css";
import "/src/design/conversation.css";
import "/src/design/features.css";

const initialLogs = Array.from({ length: 60 }, (_, index) => ({ id: `log-${index}`, createdAt: new Date(Date.parse("2026-10-11T00:00:00Z") + index * 1000).toISOString(), kind: "message", category: "message", title: "业务进度", text: `第 ${index + 1} 项业务检查：接口边界、输入验证、兼容性与测试证据已逐项检查。保留此前完成的工作，继续检查下一项。` }));
const result = { outcome: "completed", humanSummary: "接口维护与回归检查已完成。", outputs: [], changedFiles: ["src/api.ts"], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: Array.from({ length: 30 }, (_, index) => `后续检查 ${index + 1}：确认部署环境兼容性。`), unresolved: [], machineResultPath: null };
function Fixture() {
  const [logs, setLogs] = useState(initialLogs);
  const [attempt, setAttempt] = useState(1);
  const [completed, setCompleted] = useState(false);
  const [open, setOpen] = useState(true);
  return <>
    <nav aria-label="Fixture stream controls" style={{ position: "fixed", top: 6, left: 6, zIndex: 100, display: "flex", gap: 5 }}>
      <button onClick={() => setLogs((current) => [...current, { ...initialLogs[0], id: `update-${current.length}`, createdAt: new Date().toISOString(), text: `新活动 ${current.length}：继续核验接口。` }])}>Append activity</button>
      <button onClick={() => setCompleted(true)}>Complete run</button>
      <button onClick={() => { setAttempt((value) => value + 1); setCompleted(false); }}>Retry run</button>
      <button onClick={() => setOpen(true)}>Open inspector</button>
    </nav>
    {open && <WorkflowAgentDrawer executionId="fixture:worker" title="接口维护 Agent" provider="claude" status={completed ? "completed" : "running"} task="检查接口兼容性并补充回归验证。" logs={logs} attempt={attempt} result={completed ? result : null} onClose={() => setOpen(false)} />}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
