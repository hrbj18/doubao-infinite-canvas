const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Studio}=require('../src/core.cjs');

test('超时提交移入待核实后允许新任务，但保留旧提交和已用预算，重启不重发',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-submission-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let time=Date.parse('2026-10-09T18:00:00+08:00');const studio=new Studio(root,{clock:()=>time});
  const file=path.join(root,'ref.png');fs.writeFileSync(file,'fixture');const image=studio.registerAsset(file),project=studio.createProject();
  const account=studio.addAccount({name:'Dola test',platform:'dola',dailyLimit:2});studio.setLogin(account.id,'ready');
  const input={projectId:project.id,platform:'dola',prompt:'小猫举剑',mode:'references',refs:[{assetId:image.id,role:'reference'}],duration:30,accountId:account.id,idempotencyKey:'old-request'};
  const task=studio.find('tasks',studio.submit(input).id);studio.reserve(task);task.submitIntentAt=time;studio.accepted(task,{conversationId:'original-conversation'});
  assert.throws(()=>studio.deferSubmission(task.id),/120/);assert.equal(studio.usage(account.id).busy,true);
  time+=121*60000;const reviewed=studio.deferSubmission(task.id);
  assert.equal(reviewed.status,'submission_review');assert.equal(reviewed.remote.conversationId,'original-conversation');assert.equal(studio.usage(account.id).used,1);assert.equal(studio.usage(account.id).busy,false);
  const next=studio.find('tasks',studio.submit({...input,duration:15,idempotencyKey:'new-request'}).id);assert.equal(studio.reserve(next).id,account.id);assert.equal(studio.usage(account.id).reserved,1);
  const restored=new Studio(root,{clock:()=>time});restored.recover();assert.equal(restored.find('tasks',task.id).status,'submission_review');assert.equal(restored.usage(account.id).used,1);
  assert.throws(()=>restored.cancel(task.id),/核实/);restored.attachVideo(task.id,'late-original-video');assert.equal(restored.find('tasks',task.id).status,'download_pending');
});

test('已有作品不得作为超时无结果任务释放占用',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-submission-result-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const studio=new Studio(root,{clock:()=>Date.parse('2026-10-09T20:00:00+08:00')});
  studio.state.tasks.push({id:'known',status:'running',submitIntentAt:Date.parse('2026-10-09T16:00:00+08:00'),vid:'known-video'});
  assert.throws(()=>studio.deferSubmission('known'),/作品/);
});
