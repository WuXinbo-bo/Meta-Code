import assert from "node:assert/strict";
import { isSessionPayload, matchesSessionNavigation } from "../src/sessionNavigation.ts";
import {
  bindPendingSessionCreation,
  pendingCreationConfirmed,
  preservePendingCreatedSession,
  reconcilePendingSessionCreation,
  sessionResourceIsKnown,
  upsertCreatedSession
} from "../src/sessionCreation.ts";
import {
  activateWorkspaceBrowserTab,
  createWorkspaceBrowserTabsState,
  openWorkspaceBrowserTab,
  reconcileWorkspaceBrowserTabs,
  workspaceBrowserResourceKey
} from "../src/workspace-browser/browserTabState.ts";

const complete = { id: "task-1", scopeKind: "workspace", workspaceId: "workspace-1", messages: [], pendingInputs: [] };
assert.equal(isSessionPayload(complete), true);
assert.equal(isSessionPayload({ ...complete, scopeKind: "standalone", workspaceId: "" }), true);
assert.equal(isSessionPayload(null), false, "a null response must never enter the session cache");
assert.equal(isSessionPayload({ ...complete, id: "" }), false);
assert.equal(isSessionPayload({ ...complete, messages: null }), false);
assert.equal(isSessionPayload({ ...complete, pendingInputs: {} }), false);
assert.equal(isSessionPayload({ ...complete, scopeKind: "unknown" }), false);

const pending = { phase: "loading", sessionId: "task-1", generation: 4, selectionGeneration: 7 };
assert.equal(matchesSessionNavigation(pending, { sessionId: "task-1", generation: 4, selectionGeneration: 7 }), true);
assert.equal(matchesSessionNavigation({ ...pending, phase: "idle" }, { sessionId: "task-1", generation: 4, selectionGeneration: 7 }), false);
assert.equal(matchesSessionNavigation({ ...pending, generation: 3 }, { sessionId: "task-1", generation: 4, selectionGeneration: 7 }), false, "late navigation responses must be ignored");
assert.equal(matchesSessionNavigation({ ...pending, sessionId: "task-2" }, { sessionId: "task-1", generation: 4, selectionGeneration: 7 }), false);

const creation = bindPendingSessionCreation({
  requestId: "session-create:test-navigation",
  scopeKey: "workspace-1",
  sessionId: null,
  phase: "requesting"
}, "task-new");
const oldSummary = { id: "task-old", title: "Old task" };
const createdSummary = { id: "task-new", title: "New task" };
const locallyAdmitted = upsertCreatedSession([oldSummary], createdSummary);
const staleInventory = preservePendingCreatedSession(locallyAdmitted, [oldSummary], creation);
assert.deepEqual(staleInventory.map((session) => session.id), ["task-new", "task-old"], "a stale inventory response must not remove the newly-created session");
assert.equal(pendingCreationConfirmed(creation, [oldSummary]), false);
assert.equal(pendingCreationConfirmed(creation, staleInventory), true);
assert.deepEqual(preservePendingCreatedSession(locallyAdmitted, [oldSummary, createdSummary], creation), [oldSummary, createdSummary], "an authoritative inventory containing the new session must win");
assert.deepEqual(preservePendingCreatedSession(locallyAdmitted, [oldSummary], { ...creation, sessionId: null }), [oldSummary], "a request without a server session id must not preserve a speculative task");
assert.deepEqual(preservePendingCreatedSession([oldSummary], [oldSummary], creation), [oldSummary], "a missing local admission must never fabricate a task");
const unconfirmedInventory = reconcilePendingSessionCreation(locallyAdmitted, [oldSummary], creation);
assert.equal(unconfirmedInventory.pending?.requestId, creation.requestId, "protection must survive a stale or failed inventory confirmation");
const confirmedInventory = reconcilePendingSessionCreation(locallyAdmitted, [oldSummary, createdSummary], creation);
assert.equal(confirmedInventory.pending, null, "protection ends only after an authoritative inventory confirms the new session");
assert.equal(confirmedInventory.confirmed, true);
assert.equal(sessionResourceIsKnown("task-new", new Set(), creation), true);
assert.equal(sessionResourceIsKnown("task-new", new Set(), { ...creation, sessionId: null }), false);

const oldResource = { kind: "conversation", conversationId: "task-old", workspaceId: "workspace-1" };
const createdResource = { kind: "conversation", conversationId: "task-new", workspaceId: "workspace-1" };
let browser = createWorkspaceBrowserTabsState();
browser = openWorkspaceBrowserTab(browser, { resource: oldResource, title: "Old task" }, undefined, 1);
browser = openWorkspaceBrowserTab(browser, { resource: createdResource, title: "New task" }, undefined, 2);
const knownIds = new Set(["task-old"]);
browser = reconcileWorkspaceBrowserTabs(browser, {
  isResourceValid: (resource) => resource.kind !== "conversation" || sessionResourceIsKnown(resource.conversationId, knownIds, creation)
});
assert.deepEqual(browser.tabs.map((tab) => tab.resource.conversationId), ["task-old", "task-new"], "tab reconciliation must retain an admitted session while the server inventory catches up");
assert.equal(browser.activeTabId, workspaceBrowserResourceKey(createdResource), "background reconciliation must not move focus back to an older conversation");
const userSelectedOldTask = activateWorkspaceBrowserTab(browser, workspaceBrowserResourceKey(oldResource), 3);
const reconciledUserSelection = reconcileWorkspaceBrowserTabs(userSelectedOldTask, {
  isResourceValid: (resource) => resource.kind !== "conversation" || sessionResourceIsKnown(resource.conversationId, knownIds, creation)
});
assert.equal(reconciledUserSelection.activeTabId, workspaceBrowserResourceKey(oldResource), "an explicit user selection must override creation focus protection");

const standaloneResource = { kind: "conversation", conversationId: "task-standalone" };
const standaloneCreation = bindPendingSessionCreation({
  requestId: "session-create:test-standalone",
  scopeKey: "__standalone__",
  sessionId: null,
  phase: "requesting"
}, "task-standalone");
assert.equal(sessionResourceIsKnown(standaloneResource.conversationId, new Set(), standaloneCreation), true, "standalone task tabs use the same creation admission contract");

console.log("session payload admission and navigation identity validation passed");
