import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { canResumeNativeSession } from '../server/runtime/sessionCompatibility.ts';

// Exercise the actual conversation admission loop: a declaration-only change
// must pass the persisted native ID to the runner, while an incompatible
// runtime must reset it before starting a turn.
const source=await readFile(new URL('../server/index.ts',import.meta.url),'utf8');
const file=ts.createSourceFile('server/index.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const fn=file.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='runSessionLoop');
assert.ok(fn);
const code=ts.transpileModule(fn.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
for(const provider of ['claude','codex','fixture-acp']){
 for(const change of ['declaration','version','path','adapter']){
  const previous={schemaVersion:1,runtimeId:provider,providerId:provider,adapterId:provider+'-adapter',source:'runtime',path:'/fixture/cli',version:'1.0',capabilityFingerprint:'old',capturedAt:'old'};
  const current={...previous,capabilityFingerprint:'new'};
  if(change==='version')current.version='2.0';
  if(change==='path')current.path='/fixture/other-cli';
  if(change==='adapter')current.adapterId='other-adapter';
  const session={engine:provider,engineSessionId:'native-history',codexThreadId:provider==='codex'?'native-history':null,runtimeBinding:previous};
  const events=[];let captured;
  const loop=vm.runInNewContext(code+'\nrunSessionLoop;',{canResumeNativeSession,runtimeBindingForProvider:async()=>current,saveState:async()=>{},appendMessage:(_s,e)=>events.push(e),mainEngineName:()=>provider,runTurn:async s=>{captured=s.engineSessionId;return 'stopped'}});
  await loop(session,{},'continue',{});
  const nativeDeclaration=provider!=='fixture-acp'&&change==='declaration';
  assert.equal(captured,nativeDeclaration?'native-history':null,provider+' '+change);
  assert.equal(events.length,nativeDeclaration?0:1);
  assert.equal(session.runtimeBinding,current);
 }
}
console.log('Native capability declaration updates retain session history; CLI/path/adapter and ACP changes preserve reset protection');
