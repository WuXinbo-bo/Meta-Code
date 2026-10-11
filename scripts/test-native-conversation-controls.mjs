import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { NativeInteractionBroker, normalizeNativeOptions, codexNativeDecision } from '../server/engines/nativeInteraction.ts';
import { CodexNativeSession, appServerItem } from '../server/engines/codex/appServerSession.ts';
import { ClaudeSessionHandle, buildClaudeSessionArgs } from '../server/engines/claude/session.ts';
const events=[];const broker=new NativeInteractionBroker((...args)=>events.push(args));
const controller=new AbortController();
const answer=broker.request('s','owner','codex',{kind:'approval',title:'Approve',detail:'Write'},controller.signal);
const prompt=broker.list('s','owner')[0];
assert.deepEqual(broker.list('s','other'),[]);
assert.throws(()=>broker.answer('s','other',prompt.id,{decision:'accept'}));
assert.throws(()=>broker.answer('other','owner',prompt.id,{decision:'accept'}));
assert.throws(()=>broker.answer('s','owner',prompt.id,{decision:'fake'}));
broker.answer('s','owner',prompt.id,{decision:'decline'});assert.deepEqual(await answer,{decision:'decline'});
assert.throws(()=>broker.answer('s','owner',prompt.id,{decision:'accept'}));
const cancelled=broker.request('s','owner','claude',{kind:'approval',title:'Late',detail:''},controller.signal);
controller.abort(new Error('stopped'));await assert.rejects(cancelled,/stopped/);assert.equal(broker.list('s','owner').length,0);
assert.throws(()=>normalizeNativeOptions({mode:'execute',approvals:'never',customAgent:null}));
assert.throws(()=>normalizeNativeOptions({mode:'execute',approvals:'ask',customAgent:'../../secret'}));
assert.deepEqual(codexNativeDecision('item/permissions/requestApproval',{permissions:{network:{enabled:true}}},{decision:'decline'}),{permissions:{},scope:'turn'});
assert.equal(appServerItem({type:'fileChange',changes:[{path:'a.js',kind:{type:'add'},diff:'+ok'}]}).changes[0].kind,'add');
assert.equal(appServerItem({type:'collabAgentToolCall',receiverThreadIds:['child'],agentsStates:{child:{status:'completed'}}}).receiver_thread_ids[0],'child');
assert.throws(()=>codexNativeDecision('item/commandExecution/requestApproval',{availableDecisions:['cancel']},{decision:'accept'}));
assert.deepEqual(codexNativeDecision('item/commandExecution/requestApproval',{availableDecisions:['accept','cancel']},{decision:'decline'}),{decision:'cancel'});
const fixture=path.resolve('scripts/fixtures/fake-native-controls.mjs');
const native=new CodexNativeSession({executable:process.execPath,args:[fixture],env:process.env,home:os.tmpdir(),cwd:process.cwd(),thread:{},turn:{},onRequest:async prompt=>prompt.kind==='question'?{answers:{scope:['Read only']}}:{decision:'decline'}});
const stream=await native.runStreamed('test',{signal:new AbortController().signal});const received=[];
for await(const e of stream.events)received.push(e);
assert.equal(received.filter(e=>e.type==='turn.completed').length,1,'child completion must not close main turn');
assert.equal(received.at(-1).usage.output_tokens,3);
assert.equal(received.find(e=>e.type==='item.completed').item.text,'Correct final','final authoritative item replaces deltas');
const claudeEvents=[];
const handle=new ClaudeSessionHandle({executable:process.execPath,executableArgs:[fixture],cwd:process.cwd(),configDir:os.tmpdir(),permissionMode:'default',signal:new AbortController().signal,outputTimeoutMs:1000,disallowNativeAgents:false,onEvent:e=>claudeEvents.push(e),onPermission:async prompt=>{await new Promise(r=>setTimeout(r,1100));return prompt.kind==='question'?{answers:{'0':['Read only']}}:{decision:'decline'}}});
try{handle.send('test');const result=await handle.nextTurn();assert.equal(result.failed,false,'waiting for a human must not trigger inactivity timeout');assert.ok(claudeEvents.some(e=>e.text==='Declined write; read only'))}finally{handle.close()}
const forkArgs=buildClaudeSessionArgs({permissionMode:'default',forkSourceId:'source',agents:{reviewer:{prompt:'Review'}},agent:'reviewer'},'branch');
assert.ok(forkArgs.includes('--fork-session'));assert.equal(forkArgs[forkArgs.indexOf('--resume')+1],'source');assert.equal(forkArgs[forkArgs.indexOf('--session-id')+1],'branch');
const originalAgentArgs=buildClaudeSessionArgs({permissionMode:'default',agent:'hook-reviewer'},'original-agent');
assert.equal(originalAgentArgs[originalAgentArgs.indexOf('--agent')+1],'hook-reviewer');assert.ok(!originalAgentArgs.includes('--agents'),'original definitions must retain their official hooks and advanced fields');
console.log('Native approval ownership, cancellation, real subprocess denial/questions, final events, human wait and official fork arguments passed');

// HTTP boundaries: owner isolation, lazy fork, and an execution starting while
// asynchronous custom-agent discovery is in progress.
const { default: express } = await import('express');
const { registerNativeConversationRoutes } = await import('../server/engines/nativeConversationRoutes.ts');
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUser={id:req.get('x-owner')||'owner'};next()});
let running=false, discoveryStartsRun=false, saves=0;
const routeSession={id:'route-session',engine:'claude',status:'idle',engineSessionId:'new-id',nativeForkSourceId:'source'};
registerNativeConversationRoutes(app,{broker,session:(id,owner)=>id===routeSession.id&&owner==='owner'?routeSession:undefined,busy:()=>running,agents:async()=>{if(discoveryStartsRun)running=true;return [{name:'reviewer',displayName:'Reviewer'}]},save:async()=>{saves++},fork:async()=>({id:'branch'})});
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const url=`http://127.0.0.1:${server.address().port}/api/sessions/${routeSession.id}/native`;
try {
 assert.equal((await fetch(url,{headers:{'x-owner':'other'}})).status,404);
 assert.equal((await (await fetch(url)).json()).canFork,false,'pending Claude fork cannot be forked');
 discoveryStartsRun=true;
 const result=await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'execute',approvals:'ask',customAgent:'reviewer'})});
 assert.equal(result.status,409);assert.equal(saves,0,'racing run must not receive changed native permissions');
 assert.equal((await fetch(url+'/fork',{method:'POST'})).status,409);
}finally{await new Promise(r=>server.close(r))}
console.log('Native HTTP owner isolation, pending-fork gating and running-mode race passed');
