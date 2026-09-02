import assert from "node:assert/strict";
import {
  activateWorkspaceBrowserTab,
  canonicalWorkspaceBrowserFilePath,
  clearWorkspaceBrowserTabs,
  closeOtherWorkspaceBrowserTabs,
  closeWorkspaceBrowserFileTabs,
  closeWorkspaceBrowserTab,
  closeWorkspaceBrowserTabsToRight,
  createWorkspaceBrowserTabsReducer,
  createWorkspaceBrowserTabsState,
  deserializeWorkspaceBrowserTabs,
  loadWorkspaceBrowserTabs,
  moveWorkspaceBrowserTab,
  moveWorkspaceBrowserTabRelative,
  moveWorkspaceBrowserTabToEdge,
  openWorkspaceBrowserTab,
  reconcileWorkspaceBrowserTabs,
  remapWorkspaceBrowserFilePath,
  remapWorkspaceBrowserFileTabs,
  reopenLastClosedWorkspaceBrowserTab,
  serializeWorkspaceBrowserTabs,
  saveWorkspaceBrowserTabs,
  setWorkspaceBrowserTabPinned,
  updateWorkspaceBrowserTabPresentation,
  workspaceBrowserConversationViewState,
  workspaceBrowserResourceKey,
  workspaceBrowserScopeId
} from "../src/workspace-browser/browserTabState.ts";

const conversation = (conversationId, workspaceId = "workspace-a") => ({ kind: "conversation", conversationId, workspaceId });
const file = (path, workspaceId = "workspace-a") => ({ kind: "file", path, workspaceId });

assert.equal(workspaceBrowserResourceKey(file("docs\\guide.md")), workspaceBrowserResourceKey(file("docs/guide.md")), "Windows and URL-style separators should address the same file");
assert.equal(workspaceBrowserResourceKey(file("README.md")), workspaceBrowserResourceKey(file("readme.md")), "Windows file identity should be case insensitive");
assert.equal(canonicalWorkspaceBrowserFilePath(".\\Docs\\README.md"), "docs/readme.md");
assert.notEqual(workspaceBrowserResourceKey(file("README.md", "workspace-a")), workspaceBrowserResourceKey(file("README.md", "workspace-b")), "the same path in different workspaces must remain independent");
assert.equal(workspaceBrowserScopeId(file("README.md", "workspace-b"), "workspace-a"), "workspace-b");
assert.equal(workspaceBrowserScopeId(conversation("chat-b", "workspace-b"), "workspace-a"), "workspace-b");
assert.equal(workspaceBrowserScopeId({ kind: "conversation", conversationId: "standalone-b" }, "workspace-a"), "standalone-b");
assert.equal(workspaceBrowserConversationViewState(conversation("chat-b"), "loading", "chat-b"), "loading");
assert.equal(workspaceBrowserConversationViewState(conversation("chat-b"), "loading", undefined), "idle", "a stale loading presentation must not leave a permanent spinner");
assert.equal(workspaceBrowserConversationViewState(conversation("chat-b"), "error", "chat-b"), "error");
assert.equal(remapWorkspaceBrowserFilePath("docs/guides/start.md", [{ from: "docs", to: "manual" }]), "manual/guides/start.md");
assert.equal(remapWorkspaceBrowserFilePath("docs-archive/start.md", [{ from: "docs", to: "manual" }]), "docs-archive/start.md", "a sibling prefix must not be treated as a child path");

let state = createWorkspaceBrowserTabsState();
state = openWorkspaceBrowserTab(state, { resource: conversation("chat-1"), title: "设计讨论" }, undefined, 1);
state = openWorkspaceBrowserTab(state, { resource: file("docs/one.md"), mode: "preview" }, undefined, 2);
assert.equal(state.tabs.length, 2);
assert.equal(state.tabs[1].transient, true);
assert.equal(state.activeTabId, workspaceBrowserResourceKey(file("docs/one.md")));

state = openWorkspaceBrowserTab(state, { resource: file("docs/two.md"), mode: "preview" }, undefined, 3);
assert.equal(state.tabs.length, 2, "a new temporary file should reuse the preview slot");
assert.equal(state.tabs[1].title, "two.md");
assert.equal(state.tabs.some((tab) => tab.resource.kind === "file" && tab.resource.path === "docs/one.md"), false);

state = setWorkspaceBrowserTabPinned(state, state.activeTabId, true);
assert.equal(state.tabs[1].pinned, true);
assert.equal(state.tabs[1].transient, false);
state = openWorkspaceBrowserTab(state, { resource: file("docs/three.md"), mode: "preview" }, undefined, 4);
assert.equal(state.tabs.length, 3, "a pinned file must not be reused as the temporary preview slot");

let fileLifecycle = remapWorkspaceBrowserFileTabs(state, "workspace-a", [{ from: "docs", to: "manual" }]);
assert.equal(fileLifecycle.tabs.some((tab) => tab.resource.kind === "file" && tab.resource.path === "manual/two.md"), true, "moving a directory must update descendant file tabs");
assert.equal(fileLifecycle.tabs.some((tab) => tab.resource.kind === "file" && tab.resource.path === "manual/three.md"), true);
fileLifecycle = closeWorkspaceBrowserFileTabs(fileLifecycle, "workspace-a", ["manual"]);
assert.equal(fileLifecycle.tabs.some((tab) => tab.resource.kind === "file"), false, "deleting a directory must close all descendant file tabs");

const chatId = workspaceBrowserResourceKey(conversation("chat-1"));
state = activateWorkspaceBrowserTab(state, chatId, 5);
state = closeWorkspaceBrowserTab(state, chatId);
assert.equal(state.activeTabId, workspaceBrowserResourceKey(file("docs/two.md")), "closing the active tab should choose its right neighbor");

let limited = createWorkspaceBrowserTabsState();
limited = openWorkspaceBrowserTab(limited, { resource: conversation("pinned"), mode: "pinned" }, { maxTabs: 3 }, 1);
limited = openWorkspaceBrowserTab(limited, { resource: conversation("old") }, { maxTabs: 3 }, 2);
limited = openWorkspaceBrowserTab(limited, { resource: conversation("newer") }, { maxTabs: 3 }, 3);
limited = openWorkspaceBrowserTab(limited, { resource: conversation("newest") }, { maxTabs: 3 }, 4);
assert.equal(limited.tabs.length, 3);
assert.equal(limited.tabs.some((tab) => tab.resource.kind === "conversation" && tab.resource.conversationId === "pinned"), true);
assert.equal(limited.tabs.some((tab) => tab.resource.kind === "conversation" && tab.resource.conversationId === "old"), false, "LRU should evict the oldest unpinned inactive tab");

let strictLimit = createWorkspaceBrowserTabsState();
strictLimit = openWorkspaceBrowserTab(strictLimit, { resource: conversation("pin-1"), mode: "pinned" }, { maxTabs: 2 }, 1);
strictLimit = openWorkspaceBrowserTab(strictLimit, { resource: conversation("pin-2"), mode: "pinned" }, { maxTabs: 2 }, 2);
assert.equal(strictLimit.tabs.filter((tab) => tab.pinned).length, 1, "one working slot must remain available when tabs are pinned");
strictLimit = openWorkspaceBrowserTab(strictLimit, { resource: conversation("working") }, { maxTabs: 2 }, 3);
assert.equal(strictLimit.tabs.length, 2, "the configured tab limit must be a hard cap");
assert.equal(strictLimit.tabs.some((tab) => tab.resource.kind === "conversation" && tab.resource.conversationId === "pin-1"), true);
assert.equal(strictLimit.tabs.some((tab) => tab.resource.kind === "conversation" && tab.resource.conversationId === "working"), true);

limited = openWorkspaceBrowserTab(limited, { resource: { kind: "workflow", workflowId: "flow-1" } }, { maxTabs: 4 }, 5);
limited = openWorkspaceBrowserTab(limited, { resource: { kind: "tool", toolId: "terminal", invocationId: "call-1" } }, { maxTabs: 5 }, 6);
assert.deepEqual(limited.tabs.slice(-2).map((tab) => tab.resource.kind), ["workflow", "tool"]);

const activeId = limited.activeTabId;
limited = updateWorkspaceBrowserTabPresentation(limited, activeId, {
  title: "SECRET CONVERSATION TITLE",
  detail: "SECRET PREVIEW BODY",
  dirty: true,
  status: "error"
});
const serialized = serializeWorkspaceBrowserTabs(limited);
assert.equal(serialized.includes("SECRET CONVERSATION TITLE"), false, "presentation titles must not be persisted");
assert.equal(serialized.includes("SECRET PREVIEW BODY"), false, "preview details must not be persisted");
assert.equal(serialized.includes('"dirty"'), false);
assert.equal(serialized.includes('"status"'), false);

const restored = deserializeWorkspaceBrowserTabs(serialized, (resource) => resource.kind === "conversation" ? { title: `Conversation ${resource.conversationId}` } : undefined, { maxTabs: 5 });
assert.equal(restored.tabs.length, limited.tabs.length);
assert.equal(restored.activeTabId, limited.activeTabId);
assert.equal(restored.tabs.every((tab) => tab.dirty === false && tab.status === "idle"), true);
assert.equal(deserializeWorkspaceBrowserTabs("not json").tabs.length, 0);

const memory = new Map();
const storage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => { memory.set(key, value); },
  removeItem: (key) => { memory.delete(key); }
};
assert.equal(saveWorkspaceBrowserTabs(storage, restored, "browser-test"), true);
assert.equal(loadWorkspaceBrowserTabs(storage, "browser-test").tabs.length, restored.tabs.length);
assert.equal(clearWorkspaceBrowserTabs(storage, "browser-test"), true);
assert.equal(loadWorkspaceBrowserTabs(storage, "browser-test").tabs.length, 0);

let ordered = createWorkspaceBrowserTabsState();
for (const [index, id] of ["a", "b", "c", "d"].entries()) {
  ordered = openWorkspaceBrowserTab(ordered, { resource: conversation(id) }, undefined, index + 1);
}
ordered = moveWorkspaceBrowserTab(ordered, workspaceBrowserResourceKey(conversation("d")), 1);
assert.deepEqual(ordered.tabs.map((tab) => tab.resource.conversationId), ["a", "d", "b", "c"]);
ordered = moveWorkspaceBrowserTabRelative(ordered, workspaceBrowserResourceKey(conversation("d")), 1);
ordered = moveWorkspaceBrowserTabToEdge(ordered, workspaceBrowserResourceKey(conversation("c")), "start");
assert.deepEqual(ordered.tabs.map((tab) => tab.resource.conversationId), ["c", "a", "b", "d"]);
ordered = closeWorkspaceBrowserTabsToRight(ordered, workspaceBrowserResourceKey(conversation("b")));
assert.deepEqual(ordered.tabs.map((tab) => tab.resource.conversationId), ["c", "a", "b"]);
assert.equal(ordered.recentlyClosed.length, 1);
ordered = reopenLastClosedWorkspaceBrowserTab(ordered, undefined, 10);
assert.deepEqual(ordered.tabs.map((tab) => tab.resource.conversationId), ["c", "a", "b", "d"]);
ordered = closeOtherWorkspaceBrowserTabs(ordered, workspaceBrowserResourceKey(conversation("a")));
assert.deepEqual(ordered.tabs.map((tab) => tab.resource.conversationId), ["a"]);

const reducer = createWorkspaceBrowserTabsReducer({ maxTabs: 2 });
let reduced = reducer(createWorkspaceBrowserTabsState(), { type: "open", input: { resource: conversation("r1") }, at: 1 });
reduced = reducer(reduced, { type: "open", input: { resource: conversation("r2") }, at: 2 });
reduced = reducer(reduced, { type: "set-pinned", tabId: reduced.tabs[0].id, pinned: true });
assert.equal(reduced.tabs[0].pinned, true);
reduced = reducer(reduced, { type: "deactivate" });
assert.equal(reduced.activeTabId, null);
assert.equal(deserializeWorkspaceBrowserTabs(serializeWorkspaceBrowserTabs(reduced)).activeTabId, null, "an intentionally deactivated browser must remain deactivated after restart");

let reducedActions = createWorkspaceBrowserTabsState();
const actionReducer = createWorkspaceBrowserTabsReducer({ maxTabs: 6 });
for (const [index, id] of ["first", "second", "third", "fourth"].entries()) {
  reducedActions = actionReducer(reducedActions, { type: "open", input: { resource: conversation(id) }, at: index + 1 });
}
const firstId = workspaceBrowserResourceKey(conversation("first"));
const secondId = workspaceBrowserResourceKey(conversation("second"));
reducedActions = actionReducer(reducedActions, { type: "move", tabId: firstId, targetIndex: 2 });
assert.deepEqual(reducedActions.tabs.map((tab) => tab.resource.conversationId), ["second", "third", "first", "fourth"], "the reducer move action must preserve the requested final index");
reducedActions = actionReducer(reducedActions, { type: "close-right", tabId: secondId });
assert.deepEqual(reducedActions.tabs.map((tab) => tab.resource.conversationId), ["second"], "close-right must remove every resource to the right");
assert.equal(reducedActions.activeTabId, secondId, "close-right must fall back to its surviving anchor when the active tab was closed");
assert.equal(reducedActions.recentlyClosed.length, 3, "bulk close must keep recoverable history within the configured cap");
reducedActions = actionReducer(reducedActions, { type: "reopen-last-closed", at: 20 });
assert.equal(reducedActions.tabs.length, 2, "reopen must restore the most recently closed tab through the reducer action");
reducedActions = actionReducer(reducedActions, { type: "close-others", tabId: secondId });
assert.deepEqual(reducedActions.tabs.map((tab) => tab.resource.conversationId), ["second"]);
assert.equal(reducedActions.activeTabId, secondId);

const reconciledInactive = reconcileWorkspaceBrowserTabs(reduced, {
  resolvePresentation: (resource) => ({ title: `Updated ${resource.kind}` })
});
assert.equal(reconciledInactive.activeTabId, null, "presentation refreshes must not reactivate a deliberately deactivated browser");
assert.equal(reconciledInactive.tabs[0].title, "Updated conversation");

let reconciledFallback = openWorkspaceBrowserTab(createWorkspaceBrowserTabsState(), { resource: conversation("keep") }, undefined, 1);
reconciledFallback = openWorkspaceBrowserTab(reconciledFallback, { resource: conversation("remove") }, undefined, 2);
reconciledFallback = reconcileWorkspaceBrowserTabs(reconciledFallback, {
  isResourceValid: (resource) => resource.kind !== "conversation" || resource.conversationId !== "remove"
});
assert.equal(reconciledFallback.tabs.length, 1);
assert.equal(reconciledFallback.activeTabId, workspaceBrowserResourceKey(conversation("keep")), "removing an active resource should select the nearest surviving fallback");

let adjacentFallback = createWorkspaceBrowserTabsState();
for (const [index, id] of ["a", "b", "c", "d"].entries()) {
  adjacentFallback = openWorkspaceBrowserTab(adjacentFallback, { resource: conversation(id) }, undefined, index + 1);
}
adjacentFallback = activateWorkspaceBrowserTab(adjacentFallback, workspaceBrowserResourceKey(conversation("b")), 6);
adjacentFallback = reconcileWorkspaceBrowserTabs(adjacentFallback, {
  isResourceValid: (resource) => resource.kind !== "conversation" || resource.conversationId !== "b"
});
assert.equal(adjacentFallback.activeTabId, workspaceBrowserResourceKey(conversation("c")), "invalidating an active tab should select its nearest right neighbor");

console.log("workspace browser tab tests passed");
