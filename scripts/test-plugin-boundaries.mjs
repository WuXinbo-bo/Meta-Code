import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowStateFiles } from '../server/plugins/orchestration/stateFiles.ts';
import { createDelegationBroker } from '../server/plugins/collaboration/broker.ts';
import { resolveTurnExecutionMode, withoutDelegationSkill } from '../server/plugins/collaboration/mode.ts';
import { WorkspaceSkillProjectionManager } from '../server/skillProjection.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-plugin-boundaries-'));
try {
  const workspace = path.join(root, 'workspace');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(workspace);
  const legacy = path.join(workspace, '.workflow');
  const checkpoint = 'nodes/research/plans/2/attempts/1';
  fs.mkdirSync(path.join(legacy, checkpoint), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'workflow.json'), JSON.stringify({ schemaVersion: 1, workflowId: 'run-one', maintenanceBranch: { id: 'maintenance-one' } }));
  fs.writeFileSync(path.join(legacy, checkpoint, 'write-manifest.json'), '{"files":["result.md"]}');
  fs.writeFileSync(path.join(legacy, checkpoint, 'result-transaction.json'), '{"status":"committed"}');
  fs.mkdirSync(path.join(legacy, 'user-documents'));
  fs.writeFileSync(path.join(legacy, 'user-documents', 'results.json'), 'user content');
  fs.writeFileSync(path.join(legacy, 'results.json'), JSON.stringify({ workflowId: 'run-one', nodes: {} }));
  const run = { id: 'run-one', workDirectory: workspace };
  const store = new WorkflowStateFiles(runtime);
  assert.equal(store.maintenance(run).id, 'maintenance-one');
  assert.equal(fs.readFileSync(path.join(runtime, run.id, checkpoint, 'write-manifest.json'), 'utf8'), '{"files":["result.md"]}');
  assert.equal(fs.existsSync(path.join(legacy, 'workflow.json')), false);
  assert.equal(fs.readFileSync(path.join(legacy, 'user-documents', 'results.json'), 'utf8'), 'user content');
  assert.equal(store.maintenance({ ...run, id: 'run-two' }), null, 'maintenance cannot leak between runs sharing a work directory');
  assert.equal(store.results({ ...run, id: 'run-two' }), null);
  assert.equal(store.checkpointDirectory(run, path.join(legacy, checkpoint)), path.join(runtime, run.id, checkpoint));
  // Simulate a crash after the durable marker and partial cleanup.
  fs.mkdirSync(path.join(legacy, checkpoint), { recursive: true });
  fs.writeFileSync(path.join(legacy, checkpoint, 'result-transaction.json'), '{"status":"committed"}');
  new WorkflowStateFiles(runtime).results(run);
  assert.equal(fs.existsSync(path.join(legacy, checkpoint, 'result-transaction.json')), false);
  assert.throws(() => store.directoryFor('../escape'), /ID/);
  const malicious = { ...run, id: 'run-link' };
  fs.symlinkSync(workspace, path.join(runtime, malicious.id), 'dir');
  assert.throws(() => new WorkflowStateFiles(runtime).results(malicious), /符号链接/);
  // Context-only skill injection removes only workbench-owned links.
  const managed = path.join(root, 'skills');
  fs.mkdirSync(path.join(managed, 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(managed, 'fixture', 'SKILL.md'), '# Fixture');
  const projections = new WorkspaceSkillProjectionManager(managed);
  projections.setBaseSkills('workspace', workspace, ['fixture']);
  const userSkill = path.join(workspace, '.agents', 'skills', 'user-owned');
  fs.mkdirSync(userSkill);
  fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# User');
  const context = new WorkspaceSkillProjectionManager(managed, undefined, true);
  context.setBaseSkills('workspace', workspace, ['fixture']);
  assert.equal(context.isAvailable(workspace, 'codex', 'fixture'), false);
  assert.equal(fs.existsSync(path.join(workspace, '.agents', 'skills', 'fixture')), false);
  assert.ok(fs.existsSync(path.join(userSkill, 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(workspace, '.claude')), false);
  assert.equal(resolveTurnExecutionMode('native', { 'claude-codex-planner': 'auto' }, 'collaborative'), 'native');
  assert.equal(resolveTurnExecutionMode(undefined, {}, 'collaborative'), 'collaborative');
  assert.equal(resolveTurnExecutionMode(undefined, { 'claude-codex-planner': 'off' }, 'collaborative'), 'native');
  assert.deepEqual(withoutDelegationSkill({ fixture: 'manual', 'claude-codex-planner': 'auto' }), { fixture: 'manual' });

  const state = { sessions: [{ id: 'parent', status: 'running' }], delegatedTasks: [] };
  let launches = 0;
  let save = async () => {};
  const broker = createDelegationBroker({
    getState: () => state,
    agentAdapterRegistry: {
      requireDescriptor: (id) => ({ id, adapterId: id, shortName: id, capabilities: { delegation: { worker: true } } }),
      requireCapabilities: (_id, requirements) => requirements || []
    },
    isWorkbenchDelegationEnabled: () => true,
    executionWorkspaceForSession: () => ({ root: workspace }),
    assertExecutionCwd: () => workspace,
    activeDelegationTasks: new Map(),
    upsertDelegatedTask: (task) => state.delegatedTasks.push({ ...task, createdAt: new Date().toISOString() }),
    saveState: () => save(),
    launchDelegatedExecution: () => launches++
  });
  const request = { parentTaskId: 'parent', prompt: 'Independent research', idempotencyKey: 'request-one' };
  const replies = await Promise.all([broker.queue(request, 'codex'), broker.queue(request, 'codex')]);
  assert.equal(launches, 1);
  assert.equal(replies.filter((reply) => reply.deduplicated).length, 1);
  await assert.rejects(broker.queue({ ...request, prompt: 'Different task' }, 'codex'), /幂等/);
  await assert.rejects(broker.queue({ ...request, depth: 1 }, 'codex'), /递归/);
  save = async () => { throw new Error('disk full'); };
  await assert.rejects(broker.queue({ ...request, prompt: 'Will fail', idempotencyKey: 'failure' }, 'claude'), /disk full/);
  assert.equal(state.delegatedTasks.length, 1);
  save = async () => { state.sessions[0].status = 'stopped'; };
  await assert.rejects(broker.queue({ ...request, prompt: 'Stop while saving', idempotencyKey: 'stop' }, 'claude'), /主任务已停止/);
  assert.equal(launches, 1);
  assert.equal(state.delegatedTasks.at(-1).status, 'interrupted');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('plugin isolation, resumable storage migration, turn modes and delegation admission passed');
