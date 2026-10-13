function videoTimingMetadata(root,vid) {
  const matches=[],timestamps=[];
  const timeKeys=/^(create_time|created_time|created_at|createdAt|update_time|updated_at|finish_time|completed_at|completion_time|timestamp|generate_time|generation_time)$/i;
  const scan=(value,path,chain=[])=>{
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach((x,i)=>scan(x,`${path}[${i}]`,chain));return;}
    const next=[...chain,{value,path}];
    if(value.video?.vid===vid){
      matches.push({path,videoKeys:Object.keys(value.video),videoDuration:typeof value.video.duration==='number'?value.video.duration:null});
      for(const entry of next){
        const objects=[entry,...['message_info','message','metadata'].filter(k=>entry.value[k]&&typeof entry.value[k]==='object').map(k=>({value:entry.value[k],path:entry.path+'.'+k}))];
        for(const obj of objects)for(const [key,v]of Object.entries(obj.value))if(timeKeys.test(key)&&(typeof v==='number'||typeof v==='string'&&/^\d{10,19}$|^\d{4}-\d{2}-\d{2}T/.test(v)))timestamps.push({path:obj.path+'.'+key,value:v});
      }
    }
    for(const[key,v]of Object.entries(value)){if(v&&typeof v==='object')scan(v,path+'.'+key,next);else if(['content','text'].includes(key)&&typeof v==='string'&&/^[\[{]/.test(v)){try{scan(JSON.parse(v),path+'.'+key,next);}catch{}}}
  };
  scan(root,'response');return {matched:matches.length>0,matches,timestamps:[...new Map(timestamps.map(t=>[t.path,t])).values()]};
}

async function inspectVideoTiming(win,vid,reload,{timeoutMs=20000}={}) {
  const debug=win.webContents.debugger;
  if(debug.isAttached())throw new Error('当前调试器正被使用，不干扰正在运行的操作');
  debug.attach('1.3');const targets=new Set();let handler,timer;
  try {
    await debug.sendCommand('Network.enable');
    const result=new Promise(resolve=>{
      timer=setTimeout(()=>resolve({matched:false,reason:'原会话响应未提供可识别的作品时间字段'}),timeoutMs);
      handler=async(_event,method,params)=>{
        if(method==='Network.responseReceived'){
          try{const u=new URL(params.response.url);if(u.hostname==='www.dola.com'&&u.pathname==='/im/conversation/batch_get')targets.add(params.requestId);}catch{}
        }
        if(method!=='Network.loadingFinished'||!targets.has(params.requestId))return;
        targets.delete(params.requestId);
        try{const body=await debug.sendCommand('Network.getResponseBody',{requestId:params.requestId});const text=body.base64Encoded?Buffer.from(body.body,'base64').toString('utf8'):body.body;if(text.length>4*1024**2)return;const metadata=videoTimingMetadata(JSON.parse(text),vid);if(metadata.matched){clearTimeout(timer);resolve(metadata);}}catch{}
      };
      debug.on('message',handler);
    });
    await reload();return await result;
  } finally {clearTimeout(timer);if(handler)debug.removeListener('message',handler);await debug.sendCommand('Network.disable').catch(()=>{});if(debug.isAttached())debug.detach();}
}
module.exports={videoTimingMetadata,inspectVideoTiming};
