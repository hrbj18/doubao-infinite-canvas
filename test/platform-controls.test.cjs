const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { chooseDuration, chooseRatio, taskView, PlatformAdapter, namedTarget, dismissDesktopPromotion, activateVideoModeButton, generationStage, dismissConversationModeMenu } = require('../src/platform.cjs');

test('模式菜单阻挡视频入口时只收起明确的对话菜单，不碰安全或付费确认',async()=>{
  let clicks=0,text='安全确认，授权生成';
  const item={innerText:'对话',getClientRects:()=>[1],click:()=>clicks++};
  const menu={get innerText(){return text;},getClientRects:()=>[1],querySelectorAll:()=>[item]};
  const context=vm.createContext({document:{querySelectorAll:()=>[menu]}});
  const wc={executeJavaScript:async source=>vm.runInContext(source,context)};
  assert.equal(await dismissConversationModeMenu(wc),false);assert.equal(clicks,0);
  text='今日免费额度已用完，确认付费生成';assert.equal(await dismissConversationModeMenu(wc),false);assert.equal(clicks,0);
  text='对话\n工作任务\n本地电脑\n工作任务\n云电脑';assert.equal(await dismissConversationModeMenu(wc),true);assert.equal(clicks,1);
});

test('免费转付费提示必须等待本人确认，不能当成参数确认或受理成功',async()=>{
  const feedback='今日视频生成免费额度已用完，本次将消耗付费额度。是否继续生成？确认生成';
  assert.equal(generationStage(feedback),'payment_confirmation');
  const task={id:'task',status:'awaiting_confirmation',paymentRequired:true};
  const adapter=Object.create(PlatformAdapter.prototype);adapter.studio={find:()=>task};
  await assert.rejects(()=>adapter.continueTask('task'),/付费/);
  await assert.rejects(()=>adapter.submitPrepared('task'),/付费/);
});

test('隐藏窗口的视频入口备用点击要求唯一、可见且未遮挡的专用按钮',()=>{
  let clicks=0,blocked=false,count=1;
  const button={innerText:'视频生成',getClientRects:()=>[1],getBoundingClientRect:()=>({x:0,y:0,width:20,height:20}),contains:()=>false,click:()=>clicks++};
  const context=vm.createContext({document:{querySelectorAll:()=>Array(count).fill(button),elementFromPoint:()=>blocked?{}:button}});
  const run=()=>vm.runInContext(`(${activateVideoModeButton.toString()})()`,context);
  blocked=true;assert.equal(run(),false);assert.equal(clicks,0);
  blocked=false;count=2;assert.equal(run(),false);assert.equal(clicks,0);
  count=1;button.innerText='安全声明';assert.equal(run(),false);assert.equal(clicks,0);
  button.innerText='视频生成';assert.equal(run(),true);assert.equal(clicks,1);
});

test('弹窗遮挡时不点击底层控件；只关闭明确的电脑版推广，不处理安全声明',async()=>{
  const covered={innerText:'视频生成',getClientRects:()=>[1],getAttribute:()=>null,getBoundingClientRect:()=>({x:0,y:0,width:20,height:20}),contains:()=>false};
  let text='安全确认',events=0;const close={getClientRects:()=>[1],getBoundingClientRect:()=>({x:30,y:0,width:20,height:20}),contains:()=>false,click:()=>events++};
  const dialog={get innerText(){return text;},getClientRects:()=>[1],querySelector:()=>close};
  const context=vm.createContext({document:{querySelectorAll:selector=>selector==='[role=dialog]'?[dialog]:[covered],elementFromPoint:(x)=>x===40?close:{}},getComputedStyle:()=>({visibility:'visible'})});
  assert.equal(vm.runInContext(`(${namedTarget.toString()})(['视频生成'])`,context),null);
  const wc={executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context)),sendInputEvent:()=>events++};
  assert.equal(await dismissDesktopPromotion(wc),false);assert.equal(events,0);
  text='下载豆包电脑版 解锁本地任务能力';assert.equal(await dismissDesktopPromotion(wc),true);assert.equal(events,1);
});

test('新视频预检保留未发送草稿，拒绝切换有未完成任务的账号',async()=>{
  const adapter=Object.create(PlatformAdapter.prototype);adapter.studio={state:{tasks:[]}};let clicked=0;
  adapter.openAccount=async()=>({webContents:{executeJavaScript:async()=>true,sendInputEvent:()=>clicked++}});
  await assert.rejects(()=>adapter.inspectOptions('account',{kind:'new_video'}),/草稿/);assert.equal(clicked,0);
  adapter.studio.state.tasks=[{accountId:'account',status:'running'}];
  await assert.rejects(()=>adapter.inspectOptions('account',{kind:'new_video'}),/未完成/);assert.equal(clicked,0);
});

test('只读刷新原提交会话，不显示浏览器或切换其他准备中的任务',async()=>{
  const task={id:'old',accountId:'account',platform:'dola',status:'submission_review',prompt:'小猫',remote:{conversationId:'original'}};
  const adapter=Object.create(PlatformAdapter.prototype),loads=[];
  adapter.studio={state:{tasks:[task]},find:()=>task};
  const wc=new EventEmitter();wc.executeJavaScript=async()=>({matched:true,text:'原会话反馈'});
  adapter.openAccount=async(_id,options)=>{assert.equal(options.visible,false);return {webContents:wc,isVisible:()=>false,loadURL:async url=>{loads.push(url);wc.emit('dom-ready');}};};
  const result=await adapter.inspectOptions('account',{kind:'conversation_reload',taskId:'old'});assert.equal(result.readOnly,true);assert.equal(result.windowVisible,false);assert.deepEqual(loads,['https://www.dola.com/chat/original']);
  task.status='download_pending';task.vid='original-video';
  const downloaded=await adapter.inspectOptions('account',{kind:'conversation_reload',taskId:'old'});assert.equal(downloaded.readOnly,true);assert.equal(loads.length,2);
  task.status='downloading';
  const duringDownload=await adapter.inspectOptions('account',{kind:'conversation_reload',taskId:'old'});assert.equal(duringDownload.readOnly,true);assert.equal(loads.length,3);
  adapter.studio.state.tasks.push({id:'other',accountId:'account',status:'awaiting_confirmation'});
  await assert.rejects(()=>adapter.inspectOptions('account',{kind:'conversation_reload',taskId:'old'}),/其他未完成任务/);assert.equal(loads.length,3);
});

test('真实发送入口允许富文本换行格式变化，但拒绝提示词内容变化',async()=>{
  let editorText='第一镜头\n\n\n持剑迎龙\n 第二镜头 女仆换装',sends=0;
  const element=(text,id)=>({innerText:text,className:'',disabled:false,title:'',getClientRects:()=>[1],getAttribute:key=>key==='data-testid'?id:null,getBoundingClientRect:()=>({x:10,y:10,width:20,height:20})});
  const editor={get innerText(){return editorText;},getClientRects:()=>[1]};
  const mode=element('视频生成','skill_input_exit_button'),model=element('模型\n2.5',null),send=element('','chat_input_send_button');
  const document={body:{innerText:''},querySelector:selector=>selector.includes('chat_input_send_button')?send:null,querySelectorAll:selector=>selector==='textarea,[contenteditable=true]'?[editor]:selector==='input[type=file]'?[]:selector.startsWith('[data-testid=')?[mode]:[model,send]};
  const context=vm.createContext({document,window:{},location:{href:'https://www.dola.com/chat/',origin:'https://www.dola.com'},getComputedStyle:()=>({visibility:'visible'})});
  const task={id:'trial',accountId:'account',attemptId:'attempt',status:'awaiting_confirmation',platform:'dola',duration:30,model:'Dreamina Seedance 2.5',prompt:'第一镜头\n持剑迎龙\n第二镜头女仆换装',prepared:{videoModeSelected:true,promptFilled:true}};
  const attempt={phase:'reserved'},adapter=Object.create(PlatformAdapter.prototype);
  adapter.studio={find:type=>type==='tasks'?task:attempt,save(){},transition:(t,status,patch)=>Object.assign(t,patch,{status})};
  const debug=new EventEmitter();let attached=false;Object.assign(debug,{isAttached:()=>attached,attach:()=>{attached=true;},detach:()=>{attached=false;},sendCommand:async()=>({})});
  const wc=new EventEmitter();Object.assign(wc,{id:1,debugger:debug,executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context)),sendInputEvent:event=>{if(event.type==='mouseUp')sends++;}});
  adapter.openAccount=async()=>({webContents:wc});
  await adapter.submitPrepared('trial');assert.equal(task.status,'reconciling');assert.equal(sends,1);
  task.status='awaiting_confirmation';task.submitIntentAt=null;attempt.phase='reserved';editorText='第一镜头\n持剑迎龙\n第二镜头变成人类';
  await assert.rejects(()=>adapter.submitPrepared('trial'),/提示词/);assert.equal(sends,1);assert.equal(task.submitIntentAt,null);
  await adapter.durationTransports.get(1)();
});

test('比例入口只显示“比例”时展开正确菜单，拒绝不存在的选项',async()=>{
  let opened=false,selected=null;
  const element=(text,key,x)=>({innerText:text,disabled:false,getClientRects:()=>[1],getAttribute:name=>name==='data-testid'?key:null,getBoundingClientRect:()=>({x,y:1,width:20,height:20})});
  const combo=element('比例','chat_input_action_video-ratio',1),option=element('16:9',null,40);
  const document={querySelector:selector=>selector.includes('chat_input_action_video-ratio')?combo:null,querySelectorAll:()=>opened?[combo,option]:[combo]};
  const context=vm.createContext({document,getComputedStyle:()=>({visibility:'visible'})});
  const wc={executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context)),sendInputEvent:event=>{if(event.type==='mouseUp'){if(event.x===11)opened=true;else selected='16:9';}}};
  assert.equal(await chooseRatio(wc,'16:9'),true);assert.equal(selected,'16:9');
  selected=null;assert.equal(await chooseRatio(wc,'21:9'),false);assert.equal(selected,null);
});

test('Dola30秒提交前模型变化时拒绝发送且不标记未知提交',async()=>{
  const task={id:'trial',accountId:'account',status:'preparing',platform:'dola',duration:30,model:'Dreamina Seedance 2.5',prompt:'五镜头',prepared:{videoModeSelected:true,promptFilled:true}};
  let events=0;
  const adapter=Object.create(PlatformAdapter.prototype);adapter.studio={find:()=>task};
  adapter.openAccount=async()=>({webContents:{executeJavaScript:async code=>code.includes('function pageProbe')?{mode:'视频生成',buttons:[{text:'模型\n2.0 Fast'}]}:true,sendInputEvent:()=>events++}});
  await assert.rejects(()=>adapter.submitPrepared('trial'),/Seedance 2\.5/);
  assert.equal(events,0);assert.equal(task.submitIntentAt,undefined);
});

test('真实输入事件设置隐藏页面的时长滑杆，验证结果而非仅点击成功', async () => {
  let value = 6, opened = false; const keys = [];
  const combo = { get innerText() { return '自动 · ' + (value + 4) + 's'; }, getClientRects: () => [1], getAttribute: () => null, getBoundingClientRect: () => ({x:1,y:1,width:20,height:20}) };
  const slider = { getClientRects: () => [1], getAttribute: key => ({'aria-valuenow':String(value),'aria-valuemin':'0','aria-valuemax':'11'}[key]), focus() {} };
  const document = { body: { get innerText() { return opened ? `时长\n${value+4}s\n4s\n15s` : ''; } }, querySelectorAll(selector) { if(selector==='[role=slider]')return opened?[slider]:[];return selector.startsWith('button')?[combo]:[]; } };
  const context = vm.createContext({ document, location:{href:'https://www.doubao.com/chat/'}, getComputedStyle:()=>({visibility:'visible'}) });
  const wc = { executeJavaScript: code => Promise.resolve(vm.runInContext(code,context)), sendInputEvent(event) { if(event.type==='mouseUp')opened=true; if(event.type==='keyDown') {keys.push(event.keyCode);if(event.keyCode==='HOME')value=0;if(event.keyCode==='RIGHT')value=Math.min(11,value+1);} } };
  assert.equal(await chooseDuration(wc,5),true); assert.equal(value+4,5);assert.deepEqual(keys,['HOME','RIGHT']);
  assert.equal(await chooseDuration(wc,7),true);assert.equal(value+4,7);
  assert.equal(await chooseDuration(wc,15),true);assert.equal(value+4,15);
  const before=keys.length;assert.equal(await chooseDuration(wc,3),false);assert.equal(keys.length,before);
});

test('模型已选Fast时预检直接核验，不反复开关菜单导致选择丢失',async()=>{
  const adapter=Object.create(PlatformAdapter.prototype);adapter.studio={state:{tasks:[]}};adapter.selectVideoMode=async()=>({selected:true});let clicks=0;
  adapter.openAccount=async()=>({isVisible:()=>false,webContents:{executeJavaScript:async source=>source.includes('function pageProbe')?{mode:'视频生成',buttons:[{text:'模型\nSeedance 2.0 Fast',className:''}],text:'视频生成'}:source.includes('function namedTarget')?{x:1,y:1}:[],sendInputEvent:()=>clicks++}});
  const result=await adapter.inspectOptions('a',{kind:'model',model:'Seedance 2.0 Fast'});assert.equal(result.windowVisible,false);assert.equal(result.clicked,true);assert.equal(clicks,0);
});

test('平台自动增加空格仍关联同一提示词；不匹配其他对话', () => {
  const document={body:{cloneNode:()=>({textContent:'生成视频：生成一个 5 秒、16:9 的视频。确认后我再开始生成视频。',querySelectorAll:()=>[]})},querySelectorAll:()=>[]};
  const context=vm.createContext({document,location:{href:'https://www.doubao.com/chat/current',pathname:'/chat/current'}});
  const view=vm.runInContext(`(${taskView.toString()})('生成一个5秒、16:9的视频。','current')`,context);
  assert.equal(view.matched,true);assert.match(view.text,/确认后/);
  assert.equal(vm.runInContext(`(${taskView.toString()})('生成一个5秒、16:9的视频。','other')`,context).matched,false);
  assert.equal(vm.runInContext(`(${taskView.toString()})('生成一个5秒、16:9的视频。','local_pending')`,context).matched,true);
});

test('Dola将标题间隔点改成日文间隔点时仍匹配完整原提示词，不接受内容改变',()=>{
  const document={body:{cloneNode:()=>({textContent:'生成视频：圣剑女仆喵・魔法试炼。猫举剑。已开始。',querySelectorAll:()=>[]})},querySelectorAll:()=>[]};
  const context=vm.createContext({document,location:{href:'https://www.dola.com/chat/current',pathname:'/chat/current'}});
  assert.equal(vm.runInContext(`(${taskView.toString()})('圣剑女仆喵·魔法试炼。猫举剑。','current')`,context).matched,true);
  assert.equal(vm.runInContext(`(${taskView.toString()})('圣剑女仆喵·魔法试炼。猫放下剑。','current')`,context).matched,false);
});

test('5秒任务拒绝平台15秒提议，未知参数不得再次发送', async () => {
  const task={id:'task',prompt:'提示词',duration:5,platform:'doubao',status:'reconciling'};let inserts=0;
  const adapter=Object.create(PlatformAdapter.prototype);adapter.studio={find:()=>task};adapter.openAccount=async()=>({webContents:{executeJavaScript:async()=>({matched:true,text:'视频生成参数确认 时长：15秒，确认后开始生成视频。'}),insertText:()=>inserts++}});
  await assert.rejects(()=>adapter.confirmParameters('task'),/时长.*不一致/);assert.equal(inserts,0);assert.equal(task.parameterConfirmationAt,undefined);
});

test('平台声明不会自动同意；明确确认后只推进原弹窗一次',async()=>{
  const declaration='安全确认\n你在本功能中上传、使用的素材，均已获充分授权。';
  const task={id:'task',accountId:'account',attemptId:'attempt',prompt:'小猫',status:'reconciling'};const attempt={phase:'uncertain'};let clicks=0;
  const adapter=Object.create(PlatformAdapter.prototype);adapter.studio={state:{tasks:[task]},find:(type)=>type==='tasks'?task:attempt,save(){},transition:(t,status,patch)=>Object.assign(t,patch,{status})};
  adapter.polling=new Set();adapter.pollAt=new Map();adapter.openAccount=async()=>({webContents:{executeJavaScript:async source=>source.includes('function taskView')?{matched:false,promptInEditor:true,url:'https://www.doubao.com/chat/'}:source.includes('function pageProbe')?{buttons:[{testId:'safety_authorization_confirm_btn'}],text:declaration+'\n取消\n确认'}:{x:10,y:10},sendInputEvent:event=>{if(event.type==='mouseUp')clicks++;}}});
  await adapter.refreshTask('task');assert.equal(clicks,0);assert.equal(task.authorizationRequired,true);assert.equal(task.submitIntentAt,null);assert.equal(attempt.phase,'reserved');
  await assert.rejects(()=>adapter.authorizeTask('task',true,'另一份声明'),/声明/);assert.equal(clicks,0);
  await adapter.authorizeTask('task',true,task.authorizationText);assert.equal(clicks,1);assert.equal(task.authorizationAccepted,true);assert.equal(task.status,'reconciling');
  await adapter.authorizeTask('task',true,task.authorizationText);assert.equal(clicks,1);
});

test('能力探测不会切换正在生成或等待确认的账号页面',async()=>{
  const adapter=Object.create(PlatformAdapter.prototype);let probes=0;adapter.probe=async()=>{probes++;};
  for(const status of ['preparing','awaiting_confirmation','running','reconciling']) {adapter.studio={state:{tasks:[{accountId:'account',status}]}};await assert.rejects(()=>adapter.discoverCapabilities('account'),/未完成任务/);}
  assert.equal(probes,0);
});
