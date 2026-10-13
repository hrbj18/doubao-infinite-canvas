import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
const calls=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const client=new Client({name:'canvas-local-validation',version:'0.2.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/mcp.mjs')],env:{...process.env,STUDIO_DATA:process.env.STUDIO_DATA||path.join(process.env.APPDATA,'CanvasStudio')},stderr:'pipe'});
try { await client.connect(transport); for(const call of Array.isArray(calls)?calls:[calls]) { const result=await client.callTool(call); const body=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'); let value; try { value=JSON.parse(body); } catch { value=body; } console.log(JSON.stringify({name:call.name,isError:!!result.isError,result:value})); if(result.isError)process.exitCode=1; } }
finally {await client.close();}
