function planDurationRequest(request,intent) {
  let url;try{url=new URL(request.url);}catch{return {action:'pass'};}
  if(!/^(?:[\w-]+\.)?dola\.com$/.test(url.hostname)||!/^\/(?:samantha\/)?chat\/(completion|stream)\/?$/.test(url.pathname)||request.method!=='POST')return {action:'pass'};
  if(intent?.platform!=='dola'||![15,30].includes(intent.duration)||!intent.pageModelVerified||intent.expiresAt<=Date.now())return {action:'pass'};
  let body;try{body=JSON.parse(request.postData);}catch{return {action:'block',reason:'无法核验生成请求格式，已在本机停止发送'};}
  const queue=[body],seen=new Set(),needle=intent.prompt.replace(/\s+/g,'');let matched=false,steps=0;
  while(queue.length&&steps++<3000&&!matched){const value=queue.shift();if(typeof value==='string'){matched=value.replace(/\s+/g,'').includes(needle);if(!matched&&/^[\[{]/.test(value)){try{queue.push(JSON.parse(value));}catch{}}}else if(value&&typeof value==='object'&&!seen.has(value)){seen.add(value);queue.push(...Object.values(value));}}
  if(!matched)return {action:'pass'};
  if(body.chat_ability?.ability_type!==17)return {action:'block',reason:'本次请求没有视频能力参数，已在本机停止发送'};
  let parameters;try{parameters=typeof body.chat_ability.ability_param==='string'?JSON.parse(body.chat_ability.ability_param):body.chat_ability.ability_param;}catch{}
  if(!parameters||typeof parameters.model!=='string'||!parameters.model||parameters.model.length>100||!/^[\w. -]+$/.test(parameters.model))return {action:'block',reason:'无法核验生成模型，已在本机停止发送'};
  const evidence={model:parameters.model,sourceDuration:parameters.duration,requestedDuration:intent.duration,ratio:parameters.ratio};
  if(!/^seedance[_ -]?v?2[._]5$/i.test(parameters.model))return {action:'block',reason:'请求中的模型与已核对的Seedance 2.5不一致，已在本机停止发送',parameters:evidence};
  const adjusted={...body,chat_ability:{...body.chat_ability,ability_param:typeof body.chat_ability.ability_param==='string'?JSON.stringify({...parameters,duration:intent.duration}):{...parameters,duration:intent.duration}}};
  return {action:'patch',postData:JSON.stringify(adjusted),parameters:evidence};
}

async function installDurationTransport(wc,intent,onEvidence,onBlocked,onTrace) {
  const debug=wc.debugger,owned=!debug.isAttached();if(owned)debug.attach('1.3');
  let closed=false,timer;
  const close=async()=>{if(closed)return;closed=true;clearTimeout(timer);debug.removeListener('message',listener);try{await debug.sendCommand('Fetch.disable');}catch{}if(owned&&debug.isAttached())debug.detach();};
  const listener=(_event,method,params)=>{
    if(method!=='Fetch.requestPaused')return;
    void(async()=>{
      const decision=planDurationRequest(params.request,intent);
      try{const url=new URL(params.request.url);onTrace?.({endpoint:url.origin+url.pathname,method:params.request.method,action:decision.action,time:Date.now()});}catch{}
      if(decision.action==='block'){
        await debug.sendCommand('Fetch.failRequest',{requestId:params.requestId,errorReason:'BlockedByClient'});
        onBlocked(decision.reason,decision.parameters);return;
      }
      if(decision.action==='patch'){
        await debug.sendCommand('Fetch.continueRequest',{requestId:params.requestId,postData:Buffer.from(decision.postData).toString('base64')});
        onEvidence(decision.parameters);return;
      }
      await debug.sendCommand('Fetch.continueRequest',{requestId:params.requestId});
    })().catch(async()=>{try{await debug.sendCommand('Fetch.failRequest',{requestId:params.requestId,errorReason:'BlockedByClient'});onBlocked('无法核验参数请求，已在本机停止发送');}catch{}});
  };
  debug.on('message',listener);
  try{await debug.sendCommand('Fetch.enable',{patterns:[{urlPattern:'*chat/completion*',requestStage:'Request'},{urlPattern:'*chat/stream*',requestStage:'Request'}]});}catch(error){await close();throw new Error('无法安装时长请求参数核验，本次尚未提交');}
  timer=setTimeout(()=>void close(),Math.max(1,intent.expiresAt-Date.now()));timer.unref?.();
  wc.once('destroyed',()=>void close());return close;
}
module.exports={planDurationRequest,installDurationTransport};
