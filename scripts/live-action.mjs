import fs from 'node:fs';
import path from 'node:path';
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const calls=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const directory=process.env.STUDIO_DATA||path.join(process.env.APPDATA,'CanvasStudio');
const runtime=JSON.parse(fs.readFileSync(path.join(directory,'runtime.json'),'utf8'));
const endpoint=new URL(runtime.url);
if(endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:')throw new Error('仅允许本地工作台');
for(const call of Array.isArray(calls)?calls:[calls]) {
  const response=await fetch(new URL('/api/action',endpoint),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${runtime.token}`},body:JSON.stringify(call),signal:AbortSignal.timeout(60000)});
  const body=await response.json();
  console.log(JSON.stringify({action:call.action,ok:response.ok,...body}));
  if(!response.ok){process.exitCode=1;break;}
}
