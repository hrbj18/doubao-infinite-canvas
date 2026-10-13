const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {dolaSourceScript,videoPreviewTarget}=require('../src/platform.cjs');
test('Dola从原会话唯一视频读取下载源，不调用国内创作目录',async()=>{
  const task={remote:{conversationId:'original'}};
  const source='https://media.example.test/original.mp4?signature=private';
  const context=vm.createContext({location:{hostname:'www.dola.com',pathname:'/chat/original'},document:{querySelectorAll:()=>[{currentSrc:source,src:source,querySelector:()=>null}]},URL});
  assert.equal(await vm.runInContext(dolaSourceScript(task),context),source);
  context.location.pathname='/chat/other';
  await assert.rejects(()=>vm.runInContext(dolaSourceScript(task),context),/原会话/);
  context.location.pathname='/chat/original';context.document.querySelectorAll=()=>[{src:source},{src:'https://media.example.test/another.mp4'}];
  await assert.rejects(()=>vm.runInContext(dolaSourceScript(task),context),/唯一/);
  const first='https://v16-dola.dola.com/old-signature/old-expiry/video/tos/mya/asset/original/';
  const last='https://v16-dola.dola.com/new-signature/new-expiry/video/tos/mya/asset/original/';
  context.document.querySelectorAll=()=>[{src:first},{src:last}];
  assert.equal(await vm.runInContext(dolaSourceScript(task),context),last);
  context.document.querySelectorAll=()=>[{src:first},{src:last.replace('/original/','/different/')}];
  await assert.rejects(()=>vm.runInContext(dolaSourceScript(task),context),/唯一/);
});

test('只点开原作品唯一视频卡片，不点击参考图或多个作品',()=>{
  const image={getBoundingClientRect:()=>({x:100,y:200,width:500,height:280,bottom:480,top:200})};
  const card={querySelector:()=>image,getBoundingClientRect:()=>image.getBoundingClientRect()};
  const context=vm.createContext({document:{querySelectorAll:()=>[card]},innerHeight:900});
  assert.equal(vm.runInContext(`(${videoPreviewTarget.toString()})()`,context).x,350);
  context.document.querySelectorAll=()=>[card,card];
  assert.equal(vm.runInContext(`(${videoPreviewTarget.toString()})()`,context),null);
});
