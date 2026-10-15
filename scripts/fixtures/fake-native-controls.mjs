import readline from 'node:readline';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const codex = process.argv.includes('app-server');
let thread='native-fixture', stage=0;
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(codex){
  if(m.method==='initialize')emit({id:m.id,result:{}});
  if(m.method==='thread/start'||m.method==='thread/resume'){
   if(m.params.threadId)thread=m.params.threadId;
   emit({id:m.id,result:{thread:{id:thread}}});
  }
  if(m.method==='turn/start'){
   emit({id:m.id,result:{turn:{id:'turn'}}});
   emit({method:'turn/started',params:{threadId:thread,turn:{id:'turn'}}});
   emit({method:'turn/completed',params:{threadId:'child',turn:{status:'completed'}}});
   emit({id:'approval-id',method:'item/commandExecution/requestApproval',params:{threadId:thread,itemId:'command',command:'node --test',availableDecisions:['accept','decline']}});
  }
  if(m.id==='approval-id'){
   if(m.result?.decision!=='decline')throw new Error('Expected real decline response');
   stage++;
   emit({id:93,method:'item/tool/requestUserInput',params:{threadId:thread,questions:[{id:'scope',question:'Scope?',options:[{label:'Read only'}]}]}});
  }
  if(m.id===93){
   if(m.result?.answers.scope.answers[0]!=='Read only')throw new Error('Missing native question answer');
   emit({method:'item/started',params:{threadId:thread,item:{id:'a',type:'agentMessage',text:''}}});
   emit({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'a',delta:'Correct '}});
   emit({method:'item/completed',params:{threadId:thread,item:{id:'a',type:'agentMessage',text:'Correct final'}}});
   emit({method:'thread/tokenUsage/updated',params:{threadId:thread,tokenUsage:{last:{inputTokens:5,outputTokens:3}}}});
   emit({method:'turn/completed',params:{threadId:thread,turn:{status:'completed'}}});
  }
 }else{
  if(m.type==='user'){
   emit({type:'system',subtype:'init',session_id:'claude-native-fixture'});
   emit({type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'blocked.txt',content:'never'},decision_reason:'Confirm write'}});
  }
  if(m.type==='control_response'&&m.response.request_id==='approval'){
   if(m.response.response.behavior!=='deny')throw new Error('Expected native deny');
   emit({type:'control_request',request_id:'question',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'Scope?',header:'Scope',options:[{label:'Read only'}]}]}}});
  }
  if(m.type==='control_response'&&m.response.request_id==='question'){
   if(m.response.response.updatedInput.answers['Scope?']!=='Read only')throw new Error('Expected native question mapping');
   emit({type:'assistant',message:{id:'answer',content:[{type:'text',text:'Declined write; read only'}]}});
   emit({type:'result',subtype:'success',result:'Declined write; read only',usage:{input_tokens:5,output_tokens:3}});
  }
 }
}
