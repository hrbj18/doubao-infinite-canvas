const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const durationScript = require('../src/platform-duration.cjs');

function contextFor(intent) {
  const events=[];
  const context=vm.createContext({window:{postMessage:v=>events.push(v)},location:{origin:'https://www.dola.com'}});
  vm.runInContext(durationScript(intent),context);
  return {context,events,send:value=>JSON.parse(vm.runInContext(`JSON.stringify(${JSON.stringify(value)})`,context))};
}
const intent=()=>({taskId:'dola-30-test',platform:'dola',duration:30,model:'Dreamina Seedance 2.5',prompts:['五镜头任务'],expiresAt:Date.now()+10000});
const body=()=>({messages:[{content:JSON.stringify({text:'五镜头任务'})}],chat_ability:{ability_type:17,ability_param:JSON.stringify({duration:10,model:'seedance_v2.5',ratio:'16:9'})}});

test('Dola 2.5 单次30秒请求保留模型、比例和原数据，并记录任务范围',()=>{
  const {send,events}=contextFor(intent()); const value=body();
  const adjusted=send(value);
  assert.equal(JSON.parse(adjusted.chat_ability.ability_param).duration,30);
  assert.equal(JSON.parse(adjusted.chat_ability.ability_param).model,'seedance_v2.5');
  assert.equal(JSON.parse(adjusted.chat_ability.ability_param).ratio,'16:9');
  assert.equal(JSON.parse(value.chat_ability.ability_param).duration,10);
  assert.equal(events.at(-1).value.taskId,'dola-30-test');
  assert.equal(events.at(-1).value.duration,30);
});

test('Dola30秒调整拒绝其他模型、任务、能力、过期意图，并可关闭',()=>{
  for(const change of [{model:'Dreamina Seedance 2.0 Fast'},{expiresAt:0},{duration:20},{platform:'doubao'}]){
    const value=body(); const {send,events}=contextFor({...intent(),...change});
    assert.deepEqual(send(value),value);assert.equal(events.length,0);
  }
  const {send,context,events}=contextFor(intent());
  const unrelated=body();unrelated.messages=[{content:'别的提示词'}];assert.deepEqual(send(unrelated),unrelated);
  const otherAbility=body();otherAbility.chat_ability.ability_type=2;assert.deepEqual(send(otherAbility),otherAbility);
  const wrongModel=body();wrongModel.chat_ability.ability_param=JSON.stringify({duration:10,model:'seedance_v2.0'});assert.deepEqual(send(wrongModel),wrongModel);
  vm.runInContext(durationScript(null),context);const value=body();assert.deepEqual(send(value),value);assert.equal(events.length,0);
});

test('准备和确认均通过同一任务策略生成30秒意图，不支持的模型保持空策略',()=>{
  const policy=durationScript.intentFor({id:'15-trial',platform:'dola',duration:15,model:'Dreamina Seedance 2.5',prompt:'五镜头任务'});
  assert.equal(policy.duration,15);assert.equal(JSON.parse(contextFor(policy).send(body()).chat_ability.ability_param).duration,15);
  assert.equal(durationScript.intentFor({id:'trial',platform:'dola',duration:30,model:'Dreamina Seedance 2.5',prompt:'五镜头任务'}).duration,30);
  assert.deepEqual(durationScript.intentFor({id:'trial',platform:'dola',duration:30,model:'Dreamina Seedance 2.5',prompt:'五镜头任务'},['五镜头任务','确认']).prompts,['五镜头任务','确认']);
  assert.equal(durationScript.intentFor({platform:'dola',duration:30,model:'Dreamina Seedance 2.0 Fast'}),null);
});

test('账号沙盒桥只转发限定的时长证据，不包含凭据和额外字段',()=>{
  let handler;const sent=[];
  const window={location:{origin:'https://www.dola.com',hostname:'www.dola.com'},addEventListener:(event,fn)=>{if(event==='message')handler=fn;}};
  const context=vm.createContext({window,require:()=>({ipcRenderer:{send:(...args)=>sent.push(args)},webFrame:{}})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/account-preload.cjs'),'utf8'),context);
  handler({source:window,origin:window.location.origin,data:{source:'canvas-studio-observer',value:{type:'duration_adjusted',taskId:'trial',duration:30,cookie:'DO-NOT-EMIT'}}});
  assert.equal(sent.length,1);assert.equal(sent[0][1].duration,30);assert.equal(sent[0][1].taskId,'trial');assert.equal(JSON.stringify(sent).includes('DO-NOT-EMIT'),false);
  handler({source:window,origin:window.location.origin,data:{source:'canvas-studio-observer',value:{type:'duration_adjusted',taskId:'trial',duration:120}}});
  assert.equal(sent.length,1);
});
