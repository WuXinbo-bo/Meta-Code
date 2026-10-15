# Native workflow validation

## Visible workbench validation

User-requested real Agent validation runs through the current workbench UI and
its existing API/web ports (normally 4338/4339), with the existing user data
profile. Create or select a workspace in the user's designated test directory,
open the task in the browser, approve its plan, and retain its task and logs for
live inspection. Do not launch another backend or isolated data profile for
these runs unless the user explicitly requests one. Store redacted reports in
the designated test directory, outside the source checkout.

Record task/workflow IDs, providers, approved scopes, independent acceptance,
protocol failures and remaining limits. Use the same task shell to validate
workflow/chat handoffs; check that no additional protocol or task directory is
created in the business workspace. Offline boundary tests may use temporary
fixtures, but their results do not replace visible real Agent validation.

## Separate regression harness

The opt-in `scripts/test-workflow-native-e2e.mjs` uses the configured native
Codex and Claude adapters in a separate backend and data root. It never changes
the running workbench or the original account profiles. Each run retains a
redacted `report.json`, copied business projects, API observations and workflow
events under the user data test-artifact directory. Copied credentials and
native temporary profiles are removed before the run exits. This separate
harness requires explicit selection; it is not the visible-workbench procedure
above and must not be reported as a run in the user's current UI.

Build current server code before starting a live run. Actual model requests use
the user's configured connection and can incur charges. The default remains the
five established cases: `codex,claude,readonly,resume,open-goal`.

```sh
npm run build
METACODE_NATIVE_TEST_CASES=codex,claude,readonly,resume,open-goal \
  node scripts/test-workflow-native-e2e.mjs
```

## Existing project copies

Additional cases require explicit selection. `METACODE_NATIVE_EXISTING_ROOT`
names the existing experiment parent containing `01-ledger-cli`, `02-issue-api`
and `03-research-board`. Project keys are `ledger`, `issue` and `research`.

- `existing-review` copies one project, creates exactly three independent
  cross-provider read-only nodes, requires observed overlap of all three nodes,
  verifies the complete copied tree is unchanged, and runs independent tests.
- `existing-maintenance` copies one project, gives a natural maintenance goal
  without prescribing its graph, requires a real added or updated regression
  test, and runs independent public-contract acceptance after completion.
- The original source manifest is rechecked after every copied-project run.
  Source copies omit prior audit/report data, credentials, dependency trees and
  Agent configuration. Symlinks are rejected rather than following files
  outside the selected project. Final copied-tree checks include hidden and
  otherwise ignored names so protocol directories cannot be hidden by the copy
  filter.

```sh
METACODE_NATIVE_EXISTING_ROOT=/path/to/existing-experiment \
METACODE_NATIVE_EXISTING_PROJECT=research \
METACODE_NATIVE_TEST_CASES=existing-review \
METACODE_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
METACODE_BROWSER_EXECUTABLE=/path/to/browser \
  node scripts/test-workflow-native-e2e.mjs

METACODE_NATIVE_EXISTING_ROOT=/path/to/existing-experiment \
METACODE_NATIVE_EXISTING_PROJECT=issue \
METACODE_NATIVE_TEST_CASES=existing-maintenance \
  node scripts/test-workflow-native-e2e.mjs
```

The default review project is `research`; default maintenance is `ledger`.
`METACODE_NATIVE_EXISTING_REVIEW_PROJECT` and
`METACODE_NATIVE_EXISTING_MAINTENANCE_PROJECT` override each separately when
selecting both cases in the same run. Each case gets its own fresh project copy.

Independent acceptance runs the existing experiment's
`verification/product-acceptance.mjs` outside the model's business root, using
`--root` and `--only` to target the new copy. A custom equivalent harness may be
selected with `METACODE_NATIVE_EXISTING_ACCEPTANCE_SCRIPT`. Acceptance must
produce nonempty checks with no failures. Research-board acceptance includes
browser checks and fails explicitly when browser tooling is unavailable.
Provider settings, raw logs and credentials are not passed into these reports.

## Native baseline

`native-baseline` uses ordinary native conversations on fresh copies of the same
CSV fixture used by `open-goal`: identical source bytes, README, user prompt and
external hidden behavior oracle. It selects native execution explicitly. The
configured model, runtime and low-effort settings match the workflow harness.
Each provider starts a new conversation and gets a separate business directory.

```sh
METACODE_NATIVE_TEST_CASES=open-goal,native-baseline \
METACODE_NATIVE_BASELINE_PROVIDERS=codex,claude \
  node scripts/test-workflow-native-e2e.mjs
```

Baseline results record observed tool events, first business action time, elapsed
time and native usage when available. Zero-only or missing usage is `null`.
This supplies a repeatable comparison entry point; one fixture or one run does
not establish general quality, cost savings or model attention improvements.
Network/provider latency and optional native capabilities must be considered
when comparing observations.

`METACODE_NATIVE_TEST_ROOT` selects the retained artifact parent, and
`METACODE_NATIVE_TEST_TIMEOUT_MS` bounds each asynchronous phase. Every run
creates a new `workflow-native-*` directory. The offline
`test:workflow-existing-fixtures` checks copy isolation, metadata exclusion,
canonical destination boundaries, hidden-directory detection and concurrency
evidence without contacting any model or loading credentials.
