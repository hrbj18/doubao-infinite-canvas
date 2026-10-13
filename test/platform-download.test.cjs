const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {downloadFromButton}=require('../src/platform-download.cjs');
const {PlatformAdapter}=require('../src/platform.cjs');
test('下载点击迟迟未返回时销毁旧窗口，阻止旧点击晚到后混入下次下载',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const task={id:'task',accountId:'account',platform:'dola',vid:'original-video',remote:{conversationId:'38418113302312209'}},account={id:'account',platform:'dola',login:'ready'};
  const adapter=Object.create(PlatformAdapter.prototype),session=new EventEmitter();let destroyed=false;
  const win={isDestroyed:()=>destroyed,destroy:()=>{destroyed=true;},webContents:{session,getURL:()=> 'https://www.dola.com/chat/38418113302312209',executeJavaScript:async script=>script.includes('function taskView')?{matched:true}:script.includes('function pageProbe')?{url:'https://www.dola.com/chat/38418113302312209',login:false,buttons:[{testId:'edit_image_download_button'}]}:new Promise(()=>{})}};
  adapter.studio={directory:os.tmpdir(),state:{tasks:[task]},find:type=>type==='tasks'?task:account,save(){}};adapter.openAccount=async()=>win;
  const outcome=adapter.download(structuredClone(task),account).then(()=>null,error=>error);
  for(let i=0;i<10;i++)await Promise.resolve();
  t.mock.timers.tick(120000);
  const error=await outcome;assert.equal(error.code,'download_start_timeout');assert.equal(destroyed,true);assert.equal(session.listenerCount('will-download'),0);
});
test('调度传入任务快照时，真实下载进度仍保存到工作台的原任务',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-live-progress-'));t.after(()=>{const outputs=path.join(root,'outputs');for(const name of fs.readdirSync(outputs))fs.rmSync(path.join(outputs,name));fs.rmdirSync(outputs);fs.rmdirSync(root);});
  const task={id:'task',accountId:'account',platform:'dola',vid:'original-video',remote:{conversationId:'38418113302312209'}},account={id:'account',platform:'dola',login:'ready'};
  const adapter=Object.create(PlatformAdapter.prototype),session=new EventEmitter(),item=new EventEmitter();let saved;
  const wc={session,getURL:()=> 'https://www.dola.com/chat/38418113302312209',executeJavaScript:async script=>script.includes('function taskView')?{matched:true}:script.includes('function pageProbe')?{url:'https://www.dola.com/chat/38418113302312209',login:false,buttons:[{testId:'edit_image_download_button'}]}:{x:20,y:20},sendInputEvent:event=>{if(event.type==='mouseUp'){session.emit('will-download',{},item,wc);item.emit('updated',{},'progressing');fs.writeFileSync(saved,Buffer.alloc(2000));item.emit('done',{},'completed');}}};
  Object.assign(item,{getMimeType:()=> 'video/mp4',getFilename:()=> 'video.mp4',getURL:()=> 'https://www.dola.com/video.mp4',setSavePath:p=>{saved=p;},getReceivedBytes:()=>2000,getTotalBytes:()=>2000,cancel(){}});
  fs.mkdirSync(path.join(root,'outputs'));
  adapter.studio={directory:root,state:{tasks:[task]},find:type=>type==='tasks'?task:account,save(){}};adapter.openAccount=async()=>({webContents:wc});
  await assert.rejects(()=>adapter.download(structuredClone(task),account),/ffprobe/);
  assert.equal(task.downloadProgress?.received,2000);assert.equal(task.downloadProgress?.total,2000);
});
test('下载已有持续字节进展时不因总时长超过初始等待时间而取消',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-download-progress-')),file=path.join(root,'video.mp4');
  t.after(()=>{for(const name of fs.readdirSync(root))fs.rmSync(path.join(root,name));fs.rmdirSync(root);});
  const session=new EventEmitter(),wc={session},item=new EventEmitter();let saved,received=0,cancelled=0;
  Object.assign(item,{getMimeType:()=> 'video/mp4',getFilename:()=> 'video.mp4',getURL:()=> 'https://www.dola.com/video.mp4',setSavePath:p=>{saved=p;},getReceivedBytes:()=>received,cancel(){cancelled++;item.emit('done',{},'cancelled');}});
  const outcome=downloadFromButton({webContents:wc},file,()=>{session.emit('will-download',{},item,wc);return true;},{timeoutMs:10}).then(value=>({value}),error=>({error}));
  await Promise.resolve();await Promise.resolve();
  t.mock.timers.tick(8);received=600;item.emit('updated',{},'progressing');
  t.mock.timers.tick(8);received=1200;item.emit('updated',{},'progressing');
  t.mock.timers.tick(8);received=2000;fs.writeFileSync(saved,Buffer.alloc(received));item.emit('done',{},'completed');
  const result=await outcome;assert.equal(result.error,undefined);assert.equal(result.value,file);assert.equal(cancelled,0);assert.equal(session.listenerCount('will-download'),0);
});
test('字节停止增长的心跳不能无限延长下载等待',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const session=new EventEmitter(),wc={session},item=new EventEmitter();let cancelled=0;
  Object.assign(item,{getMimeType:()=> 'video/mp4',getFilename:()=> 'video.mp4',getURL:()=> 'https://www.dola.com/video.mp4',setSavePath(){},getReceivedBytes:()=>0,cancel(){cancelled++;item.emit('done',{},'cancelled');}});
  const outcome=downloadFromButton({webContents:wc},path.join(os.tmpdir(),'never-written.mp4'),()=>{session.emit('will-download',{},item,wc);return true;},{timeoutMs:10}).then(()=>null,error=>error);
  await Promise.resolve();await Promise.resolve();
  t.mock.timers.tick(8);item.emit('updated',{},'progressing');t.mock.timers.tick(4);
  assert.ok(await outcome);assert.equal(cancelled,1);assert.equal(session.listenerCount('will-download'),0);
});
test('原作品下载按钮只保存所属窗口的下载，完成后清理监听并保留已有原片',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-native-download-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'official.mp4'),original=path.join(root,'preview.mp4');fs.writeFileSync(original,'old-preview');
  const session=new EventEmitter(),wc={session},win={webContents:wc},item=new EventEmitter();let clicked=0,saved;
  Object.assign(item,{getMimeType:()=> 'video/mp4',getFilename:()=> 'video.mp4',getURL:()=> 'https://www.dola.com/video.mp4?signature=DO-NOT-EMIT',setSavePath:value=>{saved=value;},getReceivedBytes:()=>2000,cancel(){}});
  const result=await downloadFromButton(win,file,async()=>{clicked++;session.emit('will-download',{},new EventEmitter(),{});session.emit('will-download',{},item,wc);fs.writeFileSync(saved,Buffer.alloc(2000));item.emit('done',{},'completed');return true;});
  assert.equal(result,file);assert.equal(clicked,1);assert.equal(fs.statSync(file).size,2000);assert.equal(fs.readFileSync(original,'utf8'),'old-preview');assert.equal(session.listenerCount('will-download'),0);
});
