const {normalizeSummary}=require('./doubao-quota.cjs');
const ENDPOINT='/alice/commerce/sale/subscription/quota/summary/';
async function readPlatformQuota(win,{timeoutMs=20000,now=Date.now}={}) {
  const wc=win.webContents,debug=wc.debugger;
  if(debug.isAttached())throw new Error('页面正在观察其他任务，稍后同步额度');
  let timer,requestId,listener,settled=false;
  try {
    debug.attach('1.3');await debug.sendCommand('Network.enable');
    return await new Promise((resolve,reject)=>{
      const finish=(error,result)=>{if(settled)return;settled=true;error?reject(error):resolve(result);};
      timer=setTimeout(()=>finish(new Error('未取得官方额度响应；余额保持未知，不恢复满额')),timeoutMs);
      listener=async(_event,method,data)=>{if(settled)return;try{
        if(method==='Network.responseReceived'){const u=new URL(data.response.url);if(u.protocol==='https:'&&u.hostname==='www.doubao.com'&&u.pathname===ENDPOINT&&data.response.status===200)requestId=data.requestId;}
        if(method==='Network.loadingFinished'&&requestId&&data.requestId===requestId){
          const result=await debug.sendCommand('Network.getResponseBody',{requestId});
          if(result.body.length>512*1024)throw new Error('额度响应过大，未采用');
          let value;try{value=JSON.parse(result.base64Encoded?Buffer.from(result.body,'base64').toString():result.body);}catch{throw new Error('官方额度响应格式无法核对');}
          finish(null,normalizeSummary(value,now()));
        }
      }catch{finish(new Error('官方额度响应无法核对，余额保持未知'));}};
      debug.on('message',listener);wc.reload();
    });
  }finally{clearTimeout(timer);if(listener)debug.removeListener('message',listener);if(debug.isAttached())debug.detach();}
}
module.exports={ENDPOINT,readPlatformQuota};
