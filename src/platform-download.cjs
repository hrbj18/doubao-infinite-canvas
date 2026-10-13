const fs=require('node:fs');

function downloadFromButton(win,file,clickDownload,{timeoutMs=45000,startTimeoutMs=timeoutMs,stallTimeoutMs=timeoutMs,maxDurationMs=30*60000,onProgress}={}) {
  const wc=win.webContents,session=wc.session,temp=file+'.part';
  return new Promise((resolve,reject)=>{
    let settled=false,item,timer,maximum,lastReceived=0,resumes=0;
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(maximum);session.removeListener('will-download',receive);if(item){item.removeListener('updated',updated);item.removeListener('done',done);}if(error){try{item?.cancel();}catch{}reject(error);}else resolve(file);};
    const wait=(ms,message,code)=>{clearTimeout(timer);timer=setTimeout(()=>{const error=new Error(message);error.code=code;finish(error);},ms);};
    const updated=(_event,state)=>{
      if(settled)return;
      try {
        const received=item.getReceivedBytes();
        if(received>2*1024**3)throw new Error('视频超过2GB下载限制');
        if(received>lastReceived){lastReceived=received;wait(stallTimeoutMs,'平台下载长时间没有字节进展，请检查网络后重试原作品');onProgress?.({received,total:typeof item.getTotalBytes==='function'?item.getTotalBytes():null,at:Date.now()});}
        if(state==='interrupted'&&resumes<2&&item.canResume?.()){resumes++;item.resume();}
      }catch(error){finish(error);}
    };
    const done=(_event,state)=>{if(settled)return;try{if(state!=='completed')throw new Error('平台下载未完成：'+state);if(!fs.existsSync(temp)||fs.statSync(temp).size<1000)throw new Error('平台下载文件不完整');fs.renameSync(temp,file);finish();}catch(error){finish(error);}};
    const receive=(event,value,sender)=>{
      if(sender!==wc)return;
      try {
        const url=new URL(value.getURL());
        if(!['https:','blob:'].includes(url.protocol)||!(/video|octet-stream/i.test(value.getMimeType())||/\.mp4$/i.test(value.getFilename()))){event.preventDefault();finish(new Error('平台正式下载未返回视频文件'));return;}
        if(item){event.preventDefault();return;}
        item=value;value.setSavePath(temp);wait(stallTimeoutMs,'平台下载长时间没有字节进展，请检查网络后重试原作品');
        value.on('updated',updated);value.once('done',done);
      }catch(error){event.preventDefault();finish(error);}
    };
    wait(startTimeoutMs,'平台下载按钮未在限定时间内启动视频下载','download_start_timeout');
    maximum=setTimeout(()=>finish(new Error('原作品下载超过最长等待时间，保留生成记录供重试')),maxDurationMs);
    session.on('will-download',receive);
    Promise.resolve().then(clickDownload).then(clicked=>{if(!clicked)finish(new Error('未唯一识别平台正式下载按钮'));}).catch(finish);
  });
}

module.exports={downloadFromButton};
