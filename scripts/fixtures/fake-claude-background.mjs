import readline from "node:readline";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  emit({type:"system", subtype:"init",session_id:"background-fixture"});
  emit({type:"system", subtype:"task_started", task_id:"review",task_type:"local_agent",is_backgrounded:true});
  emit({type:"assistant",parent_tool_use_id:"review-tool",message:{id:"child",content:[{type:"tool_use",id:"child-read",name:"Read",input:{file_path:"child.md"}}]}});
  emit({type:"result",subtype:"success",result:"Reviewer is still working",usage:{input_tokens:1,output_tokens:1}});
  await new Promise(resolve=>setTimeout(resolve,80));
  emit({type:"system", subtype:"task_updated",task_id:"review",patch:{status:"completed"}});
  emit({type:"system", subtype:"task_notification",task_id:"review",status:"completed",summary:"Review passed"});
  emit({type:"assistant",message:{id:"final",content:[{type:"text",text:"Review consumed; origin="+(input.origin?.kind||"unset")}]}});
  emit({type:"result",subtype:"success",result:"Review consumed",usage:{input_tokens:2,output_tokens:2}});
}
