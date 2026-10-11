import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import { NativeTerminalManager, terminalSize } from '../server/engines/nativeTerminal.ts';
import { registerNativeTerminalRoutes } from '../server/engines/nativeTerminalRoutes.ts';
import { codexTerminalConfigArgs, terminalMcpEnvironment } from '../server/engines/nativeTerminalLaunch.ts';
const made=[];
let released=0;
const manager=new NativeTerminalManager(async()=>{
 const bus=new EventEmitter();
 const p={pid:1,write:d=>bus.emit('data',d),resize:(c,r)=>{p.size=[c,r]},kill:()=>{},onData:cb=>{bus.on('data',cb);return{dispose:()=>bus.off('data',cb)}},onExit:cb=>{bus.on('exit',cb);return{dispose:()=>bus.off('exit',cb)}},bus}; made.push(p);return p;
});
const options=id=>({sessionId:id,ownerId:'owner',provider:'claude',cwd:process.cwd(),executable:process.execPath,args:[],env:{},release:()=>released++});
const snap=await manager.start(options('one'));
assert.equal(manager.snapshot('one','other'),null);
manager.input('one','owner',snap.id,'first');
const events=[];manager.subscribe('one','owner',()=>{throw Error('disconnected')});manager.subscribe('one','owner',e=>events.push(e));
manager.input('one','owner',snap.id,'second');assert.equal(events.length,1);
assert.equal(manager.snapshot('one','owner',1).events[0].data,'second');
manager.resize('one','owner',snap.id,1000,-1);assert.deepEqual(made[0].size,[300,8]);
made[0].bus.emit('exit',{exitCode:0});made[0].bus.emit('exit',{exitCode:0});assert.equal(released,1);
assert.equal(manager.snapshot('one','owner').status,'exited');
const replacement=await manager.start(options('one'));assert.notEqual(replacement.id,snap.id);
assert.throws(()=>manager.input('one','owner',snap.id,'late'),/重新连接/);
for(const id of ['two','three','four'])await manager.start(options(id));
await assert.rejects(manager.start(options('five')),/4/);assert.equal(released,2);
for(let i=1;i<made.length;i++)made[i].bus.emit('exit',{exitCode:0});
const replay=await manager.start(options('replay'));
const replayProcess=made.at(-1);
for(let i=0;i<2200;i++)replayProcess.bus.emit('data','x'.repeat(200));
const retained=manager.snapshot('replay','owner',1);
assert.equal(retained.truncated,true);
assert.ok(retained.events.length<=2048);
assert.ok(retained.events.map(e=>e.data||'').join('').length<=256000);
replayProcess.bus.emit('exit',{exitCode:0});
for(let i=0;i<40;i++){await manager.start(options('history-'+i));made.at(-1).bus.emit('exit',{exitCode:0})}
assert.equal(manager.snapshot('history-0','owner'),null,'closed terminal replay must have a bounded retention');
assert.equal(manager.snapshot('history-39','owner').status,'exited');

// Exercise authenticated routing and a replacement terminal's SSE snapshot.
const app=express();app.use(express.json());app.use((req,res,next)=>{req.authUser={id:'owner'};next()});
registerNativeTerminalRoutes(app,{manager,authorize:id=>id==='route',prepare:async()=>options('route')});
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port+'/api/sessions/route/native-terminal';
try{
 const started=await fetch(base,{method:'POST'}).then(r=>r.json());made.at(-1).bus.emit('data','replacement-replay');
 assert.equal((await fetch(base+'/input',{method:'POST'})).status,409,'missing input must return a controlled error');
 assert.equal((await fetch(base+'/resize',{method:'POST'})).status,200,'missing resize body must not throw');
 assert.equal((await fetch(base.replace('/route/','/foreign/'))).status,404);
 const response=await fetch(base+'/events?after=999999&terminalId=stale-instance');const reader=response.body.getReader();
 const chunk=await reader.read();assert.match(new TextDecoder().decode(chunk.value),/replacement-replay/,'new instances must reset a previous sequence cursor');await reader.cancel();
 made.at(-1).bus.emit('exit',{exitCode:0});
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}

// Shutdown while an asynchronous PTY start is in flight must still kill it.
let fulfill;let shutdownRelease=0;
const shutdownBus=new EventEmitter();
const pendingManager=new NativeTerminalManager(()=>new Promise(resolve=>{fulfill=resolve}));
const pendingStart=pendingManager.start({...options('pending'),release:()=>shutdownRelease++});
pendingManager.stopAll();
fulfill({pid:2000000000,write:()=>{},resize:()=>{},kill:()=>shutdownBus.emit('exit',{exitCode:0}),onData:cb=>{shutdownBus.on('data',cb);return{dispose(){}}},onExit:cb=>{shutdownBus.on('exit',cb);return{dispose(){}}}});
await pendingStart;assert.equal(pendingManager.snapshot('pending','owner').status,'exited');assert.equal(shutdownRelease,1);
await assert.rejects(pendingManager.start(options('late')),/关闭/);
const original={mcp_servers:{test:{command:'node',env:{SECRET:'not-for-argv'}}}};
const safe=terminalMcpEnvironment(original,{});
assert.equal(safe.env.SECRET,'not-for-argv');
assert.ok(!codexTerminalConfigArgs(safe.config).join(' ').includes('not-for-argv'));
assert.deepEqual(safe.config.mcp_servers.test.env_vars,['SECRET']);assert.equal(original.mcp_servers.test.env.SECRET,'not-for-argv');
assert.throws(()=>terminalMcpEnvironment({mcp_servers:{a:{env:{KEY:'a'}},b:{env:{KEY:'b'}}}},{}),/冲突/);
assert.throws(()=>terminalMcpEnvironment({mcp_servers:{a:{env:{OPENAI_API_KEY:'mcp-key'}}}},{OPENAI_API_KEY:'provider-key'}),/冲突/);
assert.deepEqual(terminalSize(Infinity,NaN),{cols:300,rows:30});
// Spawn the installed native PTY against Node (no model call, no extra backend).
if(process.platform==='darwin'||process.platform==='linux'){
 const real=new NativeTerminalManager();let release=0;
 const started=await real.start({...options('pty'),executable:process.execPath,args:['-e','console.log("PTY-OK");setTimeout(()=>process.exit(0),80)'],env:process.env,release:()=>release++});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PTY timeout')),4000);real.subscribe('pty','owner',e=>{if(e.type==='exit'){clearTimeout(timer);resolve()}})});
 assert.equal(real.snapshot('pty','owner').status,'exited');assert.equal(release,1);assert.match(real.snapshot('pty','owner').events.map(e=>e.data||'').join(''),/PTY-OK/);
}
console.log('Native terminal owner isolation, replay, capacity, leases, stale input, secret-free arguments and actual PTY passed');
