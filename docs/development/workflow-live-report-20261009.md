# Visible workflow validation report

Date: 2026-10-09

This report records validation through the existing visible Meta Code workbench
and its normal API/UI ports. It does not include credentials, raw model
transcripts, or a second backend.

## Cases

- Round 1: Codex planned and implemented the existing `sum` repair; Claude
  performed read-only verification. The original project passed its tests and
  the workflow-to-chat handoff retained the task history.
- Round 2: Claude planned three independent read-only checks on an existing
  ledger project. Codex and Claude both ran, one blocked node was retried after
  a provider-aware prompt fix, and all three completed. The existing project
  passed 18/18 tests and its full manifest had no changes.
- Continuity: a normal conversation used the private task-history tool to read
  the earlier user goal, provider constraints, and no-extra-directory rule.
- Round 3: one Claude write node added `product(left, right)` and positive,
  negative, and zero tests to the existing math project. Only the two approved
  files changed, `node --test` passed 5/5, and the independent Validator passed.

All cases used the designated visible test parent and retained their tasks and
logs for inspection. No protocol or task directory was created inside the
business project.

## Evidence and limits

The final offline regression suite passed 131/131 entries, including the
supplemental log and planner-budget tests. TypeScript typecheck,
Vite production build, focused activity/log tests, and the visible browser
check passed. The third workflow used standard validation: the single node was
verified independently and its result was reused; a redundant Integrator was
not started.

The shared change was synchronized to Windows `main`; its typecheck, production
build and 130 offline entries passed on the Mac host. Its suite omits the
Mac-specific launcher test. The Mac checkout remains on `mac版` and the current
workbench was restarted after validation.

The screenshot-reported empty rows were traced to SDK `agent_message` events
whose raw text was whitespace. Twelve such placeholders in the retained round
3 snapshot are now filtered while 8 tool entries and 1 reconnect entry remain.
New blank markers do not advance workflow log revisions. Unknown transport
providers inherit the active Agent icon; system records use a system icon, so
the old `U`/`W` fallback avatars are no longer shown.

The normal conversation timeline now uses the same evidence rule: whitespace
assistant text or retained raw empty `agent_message` items are hidden only in
the view, without rewriting history. Five old `Codex 回复` rows in the earlier
continuity conversation have already lost their original SDK payload during
storage compaction. They remain visible because their label alone cannot prove
that the actual reply was empty. Real replies matching that label, task handoff
cards, user messages, and tool events are preserved by focused boundary tests.

The measurements are acceptance observations, not proof of universal speed,
cost, or quality gains. Native implicit file reads are still capability-gated;
external side effects do not have a general exactly-once guarantee; adaptive
provider routing, automatic decision knowledge, and repeated large-project
A/B evaluation remain future work. The checks also do not replace native
Windows CLI and packaged-runtime validation.

Five old normal-conversation label rows lack the original SDK body evidence.
They are retained rather than deleting potentially real text; new empty
messages and historical entries with explicit whitespace evidence are filtered.
