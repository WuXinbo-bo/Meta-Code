import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { HelpProvider } from "./help/HelpProvider";
import { applyTheme, getInitialTheme } from "./branding/ThemeToggle";
import "./styles.css";
import "./design/tokens.css";
import "./design/shell.css";
import "./design/conversation.css";
import "./design/features.css";
import "./design/workflow.css";

applyTheme(getInitialTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <HelpProvider><App /></HelpProvider>
    </AppErrorBoundary>
  </StrictMode>
);
