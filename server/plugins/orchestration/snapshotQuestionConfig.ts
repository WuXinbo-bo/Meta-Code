/** Native CLI switches verified against the Codex config schema and a local request inventory. */
export const snapshotQuestionCodexConfig = {
  features: {
    shell_tool: false, unified_exec: false, apply_patch_freeform: false,
    view_image: false, js_repl: false, multi_agent: false, collab: false,
    apps: false, plugins: false, web_search: false, code_mode: false,
    computer_use: false, browser_use: false, image_generation: false,
    goals: false, collaboration_modes: false, default_mode_request_user_input: false,
    memories: false, memory_tool: false, shell_snapshot: false
  },
  web_search: "disabled",
  project_doc_max_bytes: 0
} as const;
