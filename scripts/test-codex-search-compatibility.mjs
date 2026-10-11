import assert from 'node:assert/strict';
import express from 'express';
import { CodexSearchCompatibility, legacySearchRequest, standaloneSearchRequest, standaloneSearchResponse } from '../server/engines/codex/searchCompatibility.ts';

const original={tools:[{type:'web_search',external_web_access:true,user_location:{type:'approximate',country:'CN'}},{type:'function',name:'sum'}],tool_choice:{type:'web_search'},include:['web_search_call.action.sources']};
const adapted=legacySearchRequest(original);
assert.equal(adapted.tools[0].type,'web_search_preview');assert.equal(adapted.tool_choice.type,'web_search_preview');assert.equal(original.tools[0].type,'web_search');assert.deepEqual(adapted.tools[1],original.tools[1]);assert.deepEqual(adapted.include,original.include);
for(const extra of [{external_web_access:false},{filters:{allowed_domains:['example.com']}},{return_token_budget:'unlimited'},{unknown:true}])assert.throws(()=>legacySearchRequest({tools:[{type:'web_search',...extra}]}),/旧版/);
const search={model:'test-model',commands:{search_query:[{q:'official search docs'}],open:[{ref_id:'https://developers.openai.com/codex/'}]},settings:{external_web_access:'live'}};
assert.equal(standaloneSearchRequest(search).tools[0].type,'web_search_preview');
assert.equal(standaloneSearchRequest(search).stream,false);
assert.equal(standaloneSearchRequest({...search,settings:{external_web_access:'live',filters:{allowed_domains:[],blocked_domains:[]},user_location:null,allowed_callers:null}}).stream,false);
assert.equal(standaloneSearchRequest({...search,commands:{search_query:[{q:'docs',domains:[],recency:null}],response_length:'short'}}).stream,false);
for(const settings of [{filters:{allowed_domains:'invalid'}},{filters:{unknown:true}},{filters:{allowed_domains:['example.com']}}])assert.throws(()=>standaloneSearchRequest({...search,settings}));
for(const commands of [{search_query:'invalid'},{search_query:[null]},{open:[{ref_id:'https://example.com',lineno:100}]},{search_query:[{q:'x'.repeat(4097)}]}])assert.throws(()=>standaloneSearchRequest({...search,commands}));
for(const commands of [{search_query:[{q:'docs',domains:['example.com']}]},{search_query:[{q:'docs',recency:1}]},{open:[{ref_id:'turn0search0'}]},{finance:[{ticker:'AAPL'}]},{click:[{ref_id:'turn0search0',id:1}]}])assert.throws(()=>standaloneSearchRequest({...search,commands}));
assert.throws(()=>standaloneSearchRequest({...search,settings:{external_web_access:false}}));
assert.throws(()=>standaloneSearchResponse({output:[{type:'message',content:[{type:'output_text',text:'invented result'}]}]}),/真实/);
const actual={output:[{type:'web_search_call',status:'completed',action:{query:'official docs',sources:[{url:'https://developers.openai.com/codex/'}]}},{type:'message',content:[{type:'output_text',text:'real result',annotations:[{type:'url_citation',url:'https://developers.openai.com/codex/'}]}]}]};
assert.match(standaloneSearchResponse(actual).output,/actual hosted/);assert.match(standaloneSearchResponse(actual).output,/developers.openai.com/);
const upstream=express();upstream.use(express.json({limit:'5mb'}));let received;let aborted=false;
upstream.post('/v1/responses/compact',(req,res)=>{received={body:req.body,auth:req.get('authorization')};res.status(200).json({object:'response.compaction',output:[{type:'compaction',encrypted_content:'opaque-checkpoint'}]})});
upstream.post('/v1/responses',(req,res)=>{
 received={body:req.body,auth:req.get('authorization')};
 if(req.body.abort){res.setHeader('Content-Type','text/event-stream');res.write('data: {}\n\n');res.on('close',()=>{aborted=true});return}
 if(req.body.fail){res.status(429).json({error:{message:'upstream limit'}});return}
 if(req.body.stream===false){res.json(actual);return}
 res.setHeader('Content-Type','text/event-stream');res.write('data: '+JSON.stringify({type:'response.output_item.added',item:{type:'web_search_call',action:{query:'official docs'}}})+'\n\n');
 res.end('data: '+JSON.stringify({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'real result',annotations:[{type:'url_citation',url:'https://developers.openai.com/codex/'}]}]}]}})+'\n\n');
});
const listen=app=>new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server))});
const upstreamServer=await listen(upstream);const app=express();const bridgeServer=await listen(app);const bridge=new CodexSearchCompatibility(bridgeServer.address().port);bridge.register(app);
const connection=bridge.connection('http://127.0.0.1:'+upstreamServer.address().port+'/v1','upstream-secret');
assert.deepEqual(bridge.connection('http://127.0.0.1:'+upstreamServer.address().port+'/v1','upstream-secret'),connection);
const send=(body,extra={})=>fetch(connection.baseUrl+'/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.apiKey,...extra},body:JSON.stringify(body)});
try{
 assert.equal((await send(original,{Authorization:'Bearer wrong'})).status,404);
 assert.equal((await send(original,{Origin:'https://example.com'})).status,404);
 assert.equal((await send(original,{'sec-fetch-site':'cross-site'})).status,404);
 assert.equal((await fetch(connection.baseUrl.replace(/[^/]+$/,'wrong')+'/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.apiKey},body:'{}'})).status,404);
 assert.equal((await send({tools:[{type:'web_search',external_web_access:false}]})).status,400);
 const response=await send(original);const stream=await response.text();assert.equal(response.status,200);assert.match(stream,/web_search_call/);assert.match(stream,/url_citation/);assert.match(stream,/developers.openai.com/);assert.ok(!stream.includes('upstream-secret'));assert.equal(received.auth,'Bearer upstream-secret');assert.equal(received.body.tools[0].type,'web_search_preview');assert.equal(received.body.tool_choice.type,'web_search_preview');
 assert.equal((await send({fail:true})).status,429);
 const compactBody={model:'test-model',input:[{type:'compaction',encrypted_content:'previous-checkpoint'}],instructions:'keep context'};
 const compact=await fetch(connection.baseUrl+'/responses/compact',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.apiKey},body:JSON.stringify(compactBody)});assert.equal(compact.status,200);assert.equal((await compact.json()).output[0].encrypted_content,'opaque-checkpoint');assert.deepEqual(received.body,compactBody);assert.equal(received.auth,'Bearer upstream-secret');
 const standalone=await fetch(connection.baseUrl+'/alpha/search',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.apiKey},body:JSON.stringify(search)});assert.equal(standalone.status,200);const result=await standalone.json();assert.match(result.output,/Sources/);assert.match(result.output,/developers.openai.com/);assert.equal(received.body.tools[0].type,'web_search_preview');assert.equal(received.body.model,'test-model');
 const large=await send({input:'x'.repeat(3*1024*1024)});assert.equal(large.status,200);await large.text();
 const cancellation=new AbortController();const pending=await fetch(connection.baseUrl+'/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.apiKey},body:JSON.stringify({abort:true}),signal:cancellation.signal});await pending.body.getReader().read();cancellation.abort();for(let i=0;i<50&&!aborted;i++)await new Promise(r=>setTimeout(r,20));assert.equal(aborted,true,'closing CLI connection must cancel upstream');
 assert.throws(()=>bridge.connection('https://user:pass@example.com/v1','secret'),/URL/);
}finally{for(const server of [bridgeServer,upstreamServer]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
console.log('Codex legacy search compatibility: restrictions, auth, streaming citations, large context, error status and cancellation passed');
