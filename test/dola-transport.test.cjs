const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {planDurationRequest,installDurationTransport}=require('../src/platform-duration-transport.cjs');
const intent=()=>({platform:'dola',duration:30,pageModelVerified:true,prompt:'五镜头完整提示词',expiresAt:Date.now()+10000});
const request=()=>({url:'https://www.dola.com/samantha/chat/completion?private=query',method:'POST',postData:JSON.stringify({auth_token:'PRIVATE',messages:[{content:JSON.stringify({text:'生成影片：五镜头完整提示词，16:9'})}],chat_ability:{ability_type:17,ability_param:JSON.stringify({model:'seedance_v2.5',duration:10,ratio:'16:9'})}})});
test('Dola15秒实发参数与任务一致，不沿用上次30秒意图',()=>{
  const decision=planDurationRequest(request(),{...intent(),duration:15});assert.equal(decision.action,'patch');
  assert.equal(JSON.parse(JSON.parse(decision.postData).chat_ability.ability_param).duration,15);assert.equal(decision.parameters.requestedDuration,15);
});
test('实际网络发送参数变为30秒，保留模型与认证；证据不携带请求正文或凭据',()=>{
  const original=request(),decision=planDurationRequest(original,intent());assert.equal(decision.action,'patch');
  const body=JSON.parse(decision.postData),parameters=JSON.parse(body.chat_ability.ability_param);assert.equal(parameters.duration,30);assert.equal(parameters.model,'seedance_v2.5');assert.equal(body.auth_token,'PRIVATE');assert.equal(JSON.parse(JSON.parse(original.postData).chat_ability.ability_param).duration,10);assert.equal(JSON.stringify(decision.parameters).includes('PRIVATE'),false);
});
test('其他账号网站、聊天与过期策略保持原样；无法核验或错误模型在本机拦截',()=>{
  assert.equal(planDurationRequest({...request(),url:'https://www.doubao.com/samantha/chat/completion'},intent()).action,'pass');
  assert.equal(planDurationRequest(request(),{...intent(),expiresAt:0}).action,'pass');
  assert.equal(planDurationRequest({...request(),postData:'invalid'},intent()).action,'block');
  const body=JSON.parse(request().postData);body.messages=[{content:'其他聊天'}];assert.equal(planDurationRequest({...request(),postData:JSON.stringify(body)},intent()).action,'pass');
  body.messages=[{content:'五镜头完整提示词'}];body.chat_ability.ability_param=JSON.stringify({model:'seedance_v2.0',duration:10});assert.equal(planDurationRequest({...request(),postData:JSON.stringify(body)},intent()).action,'block');
});
test('调试器真正发送Base64正文，并记录参数；无法核验时只阻断发送',async()=>{
  const debug=new EventEmitter(),calls=[],evidence=[],blocks=[];let attached=false;
  Object.assign(debug,{isAttached:()=>attached,attach:()=>{attached=true;},detach:()=>{attached=false;},sendCommand:async(name,args)=>{calls.push({name,args});}});
  const wc=new EventEmitter();wc.debugger=debug;
  const close=await installDurationTransport(wc,intent(),value=>evidence.push(value),value=>blocks.push(value));
  debug.emit('message',{},'Fetch.requestPaused',{requestId:'one',request:request()});await new Promise(resolve=>setImmediate(resolve));
  const send=calls.find(x=>x.name==='Fetch.continueRequest'&&x.args.requestId==='one');assert.equal(JSON.parse(JSON.parse(Buffer.from(send.args.postData,'base64').toString()).chat_ability.ability_param).duration,30);assert.equal(evidence.length,1);
  debug.emit('message',{},'Fetch.requestPaused',{requestId:'two',request:{...request(),postData:'invalid'}});await new Promise(resolve=>setImmediate(resolve));assert.ok(calls.some(x=>x.name==='Fetch.failRequest'&&x.args.requestId==='two'));assert.equal(blocks.length,1);
  await close();assert.equal(debug.listenerCount('message'),0);assert.equal(attached,false);
});
