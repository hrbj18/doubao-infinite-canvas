const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { Studio } = require('../src/core.cjs');
const { Workflows } = require('../src/workflows.cjs');
const { execute, extractFrame, videoInfo } = require('../src/media.cjs');
const durationScript = require('../src/platform-duration.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-workflow-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(root).startsWith('studio-workflow-')); fs.rmSync(root, { recursive: true, force: true }); });
  const studio = new Studio(root), project = studio.createProject('分镜'), workflows = new Workflows(studio);
  return { root, studio, project, workflows };
}
async function clip(root, name, withAudio = false) {
  const file = path.join(root, name + '.mp4');
  await execute('ffmpeg', ['-v','error','-y','-f','lavfi','-i',name === 'blue' ? 'color=blue:size=160x120:rate=10' : 'testsrc=size=128x96:rate=25',...(withAudio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[]),'-t','2','-pix_fmt','yuv420p',file]);
  return file;
}
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('精确尾帧像素等于最后一帧，而非结束前0.1秒；记录素材来源', async t => {
  const f = fixture(t), file = await clip(f.root, 'terminal'), video = f.studio.registerAsset(file, {kind:'video'});
  const actual = await extractFrame(f.studio,{assetId:video.id,position:'last'}), expected = path.join(f.root,'expected.png');
  await execute('ffmpeg',['-v','error','-y','-i',file,'-vf','select=eq(n\\,49)','-frames:v','1','-update','1',expected]);
  const pixels = file => execute('ffmpeg',['-v','error','-i',file,'-frames:v','1','-f','hash','-hash','md5','-']);
  assert.equal(await pixels(actual.file),await pixels(expected));
  const early = await extractFrame(f.studio,{assetId:video.id,time:1.9}); assert.notEqual(await pixels(actual.file),await pixels(early.file));
  assert.equal(actual.sourceFrame.assetId,video.id); assert.equal(actual.sourceFrame.selection,'last_decodable');
});
test('同镜头续接和新分镜保持来源、角色及参数；重复调用与重启不重复建节点', async t => {
  const f=fixture(t), file=await clip(f.root,'source'), video=f.studio.registerAsset(file,{kind:'video'});
  f.studio.saveProject(f.project.id,{nodes:[{id:'source-video',type:'video',assetId:video.id,name:'上一段',x:20,y:40}]});
  const input={projectId:f.project.id,kind:'continue',sourceVideoAssetId:video.id,prompt:'小猫继续举剑',duration:5,ratio:'16:9',idempotencyKey:'continue'};
  const [first,repeated]=await Promise.all([f.workflows.createShot(input),f.workflows.createShot(input)]);
  assert.equal(first.nodeId,repeated.nodeId); assert.equal(first.mode,'first'); assert.equal(first.submitted,false); assert.equal(f.studio.state.tasks.length,0);
  const project=f.studio.find('projects',f.project.id), node=project.nodes.find(n=>n.id===first.nodeId);
  assert.equal(node.sourceVideoAssetId,video.id); assert.equal(node.duration,5); assert.ok(project.edges.some(e=>e.kind==='frame'));
  assert.equal(project.edges.filter(e=>e.to===node.id&&e.kind==='input')[0].role,'first');
  const fresh=await f.workflows.createShot({projectId:f.project.id,kind:'new',sourceVideoAssetId:video.id,imageAssetId:first.firstAssetId,lastAssetId:first.firstAssetId,idempotencyKey:'new'});
  assert.equal(fresh.mode,'first_last'); assert.equal(fresh.firstAssetId,first.firstAssetId); assert.equal(project.nodes.find(n=>n.id===fresh.nodeId).shotKind,'new_shot');
  await assert.rejects(()=>f.workflows.createShot({...input,prompt:'不同参数'}),/不同参数/);
  // 模拟节点已保存而操作结果未保存时重启。
  const op=f.studio.state.workflowOperations.find(x=>x.key==='continue'); op.status='preparing';delete op.result; f.studio.save();
  const restored=new Studio(f.root), result=await new Workflows(restored).createShot(input);
  assert.equal(result.nodeId,first.nodeId);assert.equal(restored.find('projects',f.project.id).nodes.length,project.nodes.length);
});
test('定长拼接保留音轨和原片，统一分辨率；不足目标不会产生视频或生成任务', async t => {
  const f=fixture(t), a=await clip(f.root,'audio',true), b=await clip(f.root,'blue');
  const aa=f.studio.registerAsset(a,{kind:'video'}), bb=f.studio.registerAsset(b,{kind:'video'}), before=[hash(aa.file),hash(bb.file)];
  const input={projectId:f.project.id,assetIds:[aa.id,bb.id],targetDuration:3.5,idempotencyKey:'export'};
  const output=await f.workflows.merge(input), info=await videoInfo(output.file);
  assert.ok(Math.abs(info.duration-3.5)<=1/info.fps+.002);assert.equal(info.hasAudio,true);assert.deepEqual([info.width,info.height],[128,96]);
  assert.deepEqual([hash(aa.file),hash(bb.file)],before);assert.equal(f.studio.state.tasks.length,0);assert.equal(f.studio.state.exports.length,1);
  assert.equal((await f.workflows.merge(input)).assetId,output.assetId);assert.equal(f.studio.state.exports.length,1);
  const assets=f.studio.state.assets.length;
  await assert.rejects(()=>f.workflows.merge({...input,targetDuration:10,idempotencyKey:'insufficient'}),/不足目标/);
  assert.equal(f.studio.state.assets.length,assets);assert.equal(f.studio.state.tasks.length,0);
});
test('15秒调整仅作用于当前任务和对应请求，5秒和其他聊天保持原样', () => {
  const messages=[],context=vm.createContext({window:{postMessage:m=>messages.push(m)},location:{origin:'https://www.doubao.com'}});
  vm.runInContext(durationScript({taskId:'task',platform:'doubao',duration:15,prompts:['唯一任务提示词'],expiresAt:Date.now()+10000}),context);
  const send=body=>JSON.parse(vm.runInContext('JSON.stringify('+JSON.stringify(body)+')',context));
  const body={chat_ability:{ability_type:17,ability_param:JSON.stringify({duration:10,ratio:'16:9'})},messages:[{content:'唯一任务提示词'}]};
  assert.equal(JSON.parse(send(body).chat_ability.ability_param).duration,15);assert.equal(JSON.parse(body.chat_ability.ability_param).duration,10);
  assert.equal(JSON.parse(send({...body,messages:[{content:'另一个聊天'}]}).chat_ability.ability_param).duration,10);
  assert.equal(JSON.parse(send({...body,messages:[{content:JSON.stringify({text:'唯一任务\n提示词'})}]}).chat_ability.ability_param).duration,15);
  vm.runInContext(durationScript(null),context);body.chat_ability.ability_param=JSON.stringify({duration:5});assert.equal(JSON.parse(send(body).chat_ability.ability_param).duration,5);
  assert.equal(messages.length,2);
});
test('手动分类预算仍隔离额度拒绝，国内15秒不再写死每天一次', t => {
  const f=fixture(t), file=path.join(f.root,'input.png');fs.writeFileSync(file,'fixture');const image=f.studio.registerAsset(file);
  const account=f.studio.addAccount({name:'账号',platform:'doubao',dailyLimit:4});f.studio.setLogin(account.id,'ready');
  const input=key=>({projectId:f.project.id,platform:'doubao',mode:'first',refs:[{assetId:image.id,role:'first'}],prompt:'猫举剑',duration:15,idempotencyKey:key});
  assert.throws(()=>f.studio.updateAccount(account.id,{quotaRelation:'independent'}),/平台证据/);assert.equal(f.studio.find('accounts',account.id).quotaRelation,undefined);
  f.studio.updateAccount(account.id,{quotaRelation:'independent',quotaEvidence:'已核对平台分类额度'});
  const failed=f.studio.find('tasks',f.studio.submit(input('reject')).id);f.studio.reserve(failed);f.studio.reject(failed,'quota','15秒已用完');
  assert.equal(f.studio.usage(account.id,'15s').available,0);assert.equal(f.studio.usage(account.id,'standard').available,4);
  f.studio.updateAccount(account.id,{quotaBucket:'15s',clearBlock:true});const task=f.studio.find('tasks',f.studio.submit(input('accepted')).id);f.studio.reserve(task);f.studio.accepted(task);f.studio.transition(task,'failed');
  assert.equal(f.studio.usage(account.id,'15s').used,1);assert.equal(f.studio.usage(account.id,'15s').available,3);assert.equal(f.studio.usage(account.id,'standard').available,4);
  f.studio.updateAccount(account.id,{quotaBucket:'15s',bucketLimit:2});assert.equal(f.studio.usage(account.id,'15s').available,1);
});
test('验证预算包括未知提交，幂等启动不会重置预算，禁止15秒测试', t => {
  const f=fixture(t),file=path.join(f.root,'input.png');fs.writeFileSync(file,'fixture');const image=f.studio.registerAsset(file);
  const a=f.studio.addAccount({name:'A',platform:'doubao',dailyLimit:4}),b=f.studio.addAccount({name:'B',platform:'doubao',dailyLimit:4});f.studio.setLogin(a.id,'ready');f.studio.setLogin(b.id,'ready');
  const run=f.studio.validation('start');assert.equal(f.studio.validation('start').id,run.id);
  const input=key=>({projectId:f.project.id,platform:'doubao',mode:'first',refs:[{assetId:image.id,role:'first'}],prompt:'猫举剑',duration:5,idempotencyKey:key,validationRunId:run.id});
  assert.throws(()=>f.studio.submit({...input('no15'),duration:15}),/禁止消耗15秒/);
  for(const key of ['first','second']) {const task=f.studio.find('tasks',f.studio.submit(input(key)).id);assert.ok(f.studio.reserve(task));f.studio.reject(task,'uncertain','等待反馈');}
  const third=f.studio.find('tasks',f.studio.submit(input('third')).id);assert.equal(f.studio.reserve(third),false);assert.match(third.reason,/上限/);assert.equal(f.studio.validation('status').usage.doubao.reserved,2);
});

test('明确未发送的准备等待可以取消；未知提交不得释放预算', t => {
  const f=fixture(t),file=path.join(f.root,'input.png');fs.writeFileSync(file,'fixture');const image=f.studio.registerAsset(file);
  const account=f.studio.addAccount({name:'A',platform:'doubao',dailyLimit:1});f.studio.setLogin(account.id,'ready');
  const input=key=>({projectId:f.project.id,platform:'doubao',mode:'first',refs:[{assetId:image.id,role:'first'}],prompt:'猫',duration:5,idempotencyKey:key});
  const a=f.studio.find('tasks',f.studio.submit(input('not-sent')).id);f.studio.reserve(a);f.studio.transition(a,'awaiting_confirmation',{reason:'等待声明',authorizationRequired:true});f.studio.cancel(a.id);
  assert.equal(f.studio.find('tasks',a.id).authorizationRequired,false);
  assert.equal(f.studio.usage(account.id).reserved,0);assert.equal(f.studio.usage(account.id).available,1);
  const b=f.studio.find('tasks',f.studio.submit(input('unknown')).id);f.studio.reserve(b);b.submitIntentAt=Date.now();f.studio.transition(b,'awaiting_confirmation');
  assert.throws(()=>f.studio.cancel(b.id),/已提交/);assert.equal(f.studio.usage(account.id).reserved,1);
});

test('Agent直接提交也回填完整画布，幂等重试和迁移不增加节点', t=>{
  const f=fixture(t),file=path.join(f.root,'input.png');fs.writeFileSync(file,'fixture');const image=f.studio.registerAsset(file);
  const input={projectId:f.project.id,platform:'doubao',mode:'first',refs:[{assetId:image.id,role:'first'}],prompt:'猫',duration:5,idempotencyKey:'agent'};
  const task=f.studio.submit(input),p=f.studio.find('projects',f.project.id);assert.equal(p.nodes.length,2);assert.equal(p.edges[0].to,task.nodeId);
  assert.equal(f.studio.submit(input).id,task.id);assert.equal(p.nodes.length,2);
  const restored=new Studio(f.root);assert.equal(restored.find('projects',p.id).nodes.length,2);
});

test('等待素材声明的未提交证据跨重启保留，不自动释放或再次生成',t=>{
  const f=fixture(t),file=path.join(f.root,'input.png');fs.writeFileSync(file,'fixture');const image=f.studio.registerAsset(file);const account=f.studio.addAccount({name:'A',platform:'doubao'});f.studio.setLogin(account.id,'ready');
  const task=f.studio.find('tasks',f.studio.submit({projectId:f.project.id,platform:'doubao',mode:'references',refs:[{assetId:image.id,role:'reference'}],prompt:'猫',idempotencyKey:'consent'}).id);f.studio.reserve(task);f.studio.transition(task,'awaiting_confirmation',{authorizationRequired:true,authorizationEvidence:'editor_not_message',submitIntentAt:null});
  const restored=new Studio(f.root);restored.recover();assert.equal(restored.find('tasks',task.id).status,'awaiting_confirmation');assert.equal(restored.usage(account.id).reserved,1);assert.equal(restored.state.tasks.length,1);
});

test('分类校准后保存总用量不会重复计入分类次数',t=>{
  const f=fixture(t),a=f.studio.addAccount({name:'A',platform:'doubao',dailyLimit:10});f.studio.updateAccount(a.id,{quotaBucket:'standard',bucketUsed:2});assert.equal(f.studio.usage(a.id).used,2);f.studio.updateAccount(a.id,{todayUsed:2});assert.equal(f.studio.usage(a.id).used,2);assert.throws(()=>f.studio.updateAccount(a.id,{todayUsed:1}),/分类用量/);assert.equal(f.studio.usage(a.id).used,2);
});
