const{test}=require('node:test');const assert=require('node:assert/strict');
const{videoTimingMetadata}=require('../src/platform-video-timing.cjs');
test('作品时间只读取同一vid的消息祖先字段，不输出认证或其他作品时间',()=>{
  const input={token:'DO-NOT-EMIT',messages:[{create_time:1000000000,content:JSON.stringify({video:{vid:'other'}})},{create_time:1791540000,message_id:'result',content:JSON.stringify({video:{vid:'target',duration:30,url:'https://example.test/?token=DO-NOT-EMIT'}})}]};
  const data=videoTimingMetadata(input,'target');assert.equal(data.matched,true);assert.equal(data.timestamps.length,1);assert.equal(data.timestamps[0].value,1791540000);assert.equal(JSON.stringify(data).includes('DO-NOT-EMIT'),false);assert.equal(videoTimingMetadata(input,'missing').matched,false);
});
