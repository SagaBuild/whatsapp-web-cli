import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {main} from '../scripts/wa.mjs';
import * as transport from '../scripts/transport.mjs';
import {createBrowserFixture} from './helpers/browser-fixture.mjs';

const scratch=await fs.realpath(os.tmpdir());
const root=await fs.mkdtemp(path.join(scratch,'wa-cli-tests-'));
const envKeys=['WA_DATA_DIR','PWTEST_DAEMON_SESSION_DIR','PWTEST_SERVER_REGISTRY','WA_PLAYWRIGHT_CLI'];
const previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const cli=fileURLToPath(new URL('../scripts/wa.mjs',import.meta.url));
const backendEntry=createRequire(import.meta.url).resolve('@playwright/cli/playwright-cli.js');
const browsers=[];
after(async()=>{
  for(const key of envKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  assert.equal(path.dirname(await fs.realpath(root)),scratch);
  assert.ok(browsers.every(browser=>browser.cleaned),'Preserve fixture registry when independent browser cleanup fails');
  await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
});

const payload='Original attachment: æ 中文 🟢\nExact bytes 000123\n';
const html=`<!doctype html><meta charset="utf-8"><style>[hidden]{display:none!important}</style>
<div id="side"></div><div id="main"><header>Team A</header>
<div data-testid="conversation-panel-messages" style="height:200px;overflow:auto">
<div data-id="document"><a role="button" href="/file" download="source.txt" title='Download "source.txt"'>Download</a></div>
<div data-id="link"><a href="https://docs.example.test/sheet?gid=42#part">Sheet</a></div>
<div data-id="anchor"><span data-testid="selectable-text">Baseline message</span></div></div>
<footer><div role="textbox" contenteditable="true"></div></footer><button aria-label="Attach" onclick="document.querySelector('#document-menu').hidden=false">Attach</button></div>
<button role="menuitem" aria-label="Document" id="document-menu" hidden onclick="choose()">Document</button><div id="preview"></div>
<script>window.sent=0;window.choosers=0;
function choose(){window.choosers++;const input=document.createElement('input');input.type='file';input.accept='*';input.multiple=true;input.id='file-input';input.hidden=true;
input.onchange=()=>{document.querySelector('#document-menu').hidden=true;const preview=document.querySelector('#preview');preview.replaceChildren();for(const file of input.files){const tab=document.createElement('div');tab.setAttribute('role','tab');tab.setAttribute('aria-label','Open document, '+file.name+', item 1 of 1');tab.textContent=file.name;preview.append(tab);}const send=document.createElement('button');send.setAttribute('aria-label','Send '+input.files.length+' selected');send.textContent='Send';send.onclick=()=>window.sent++;preview.append(send);};document.body.append(input);input.click();}</script>`;

function invoke(args,{cwd=root}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,...args,'--session','fixture'],{cwd,windowsHide:true,shell:false,env:process.env});
    let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
    child.once('error',reject);child.once('close',exitCode=>{
      try{resolve({exitCode,...JSON.parse(stdout)});}catch(error){reject(new Error(`CLI did not return JSON: ${stdout}\n${stderr}`,{cause:error}));}
    });
  });
}

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(root,'case-'));
  process.env.WA_DATA_DIR=path.join(directory,'data');
  process.env.PWTEST_DAEMON_SESSION_DIR=path.join(directory,'daemon');
  process.env.PWTEST_SERVER_REGISTRY=path.join(directory,'servers');
  process.env.WA_PLAYWRIGHT_CLI=backendEntry;
  const config=transport.settings('fixture');
  const browser=createBrowserFixture(config,{root});browsers.push(browser);
  t.after(()=>browser.cleanup());
  // This exact origin is fulfilled in-process before navigation; no WhatsApp
  // network request or account is involved. The CLI's real origin guard runs.
  await transport.openBrowser(config,{url:'about:blank'});
  await browser.record();
  await transport.act(config,async(page,_op,args)=>{
    await page.context().route('**/*',async route=>{
      const url=route.request().url();
      if(url==='https://web.whatsapp.com/')return route.fulfill({contentType:'text/html',body:args.html});
      if(url==='https://docs.example.test/sheet?gid=42')return route.fulfill({contentType:'text/html',body:'<title>Synthetic link</title>'});
      return route.abort();
    });
    await page.goto('https://web.whatsapp.com/');
    // Serve an original browser Blob. Chromium can cancel network downloads
    // from a virtual HTTPS origin whose response exists only in route.fulfill.
    await page.locator('[data-id="document"] a').evaluate((anchor,content)=>{anchor.href=URL.createObjectURL(new Blob([content],{type:'application/octet-stream'}));},args.payload);
    return {ready:true};
  },'fixture',{html,payload});
  const run=args=>invoke(args,{cwd:directory});
  const backend={...transport,settings:()=>config};
  return {directory,config,run,backend};
}

test('The actual CLI downloads exact bytes, composes exact text, returns links and reports partial failure', {timeout:120000},async t=>{
  const f=await fixture(t),out=path.join(f.directory,'downloads');
  const first=await f.run(['download','--chat','Team A','--message','document','--out',out]);
  assert.equal(first.exitCode,0,JSON.stringify(first));assert.equal(first.ok,true);
  assert.deepEqual(await fs.readFile(first.data.results[0].path),Buffer.from(payload));
  const again=await f.run(['download','--chat','Team A','--message','document','--out',out]);
  assert.equal(again.data.results[0].status,'skipped_verified');
  assert.equal(again.data.results[0].path,first.data.results[0].path);
  const links=await f.run(['links','--chat','Team A']);
  assert.equal(links.exitCode,0);assert.equal(links.data.links.at(-1).url,'https://docs.example.test/sheet?gid=42#part');
  const text='Exact draft: æ 中文 🟢\nLine two has `literal` $characters';
  const file=path.join(f.directory,'text.txt');await fs.writeFile(file,text);
  assert.equal((await f.run(['compose','--chat','Team A','--text-file',file])).exitCode,0);
  assert.equal(await transport.act(f.config,async page=>page.locator('#main footer [role="textbox"]').innerText(),'read-draft'),text);
  await transport.act(f.config,async page=>{
    await page.locator('[data-testid="conversation-panel-messages"]').evaluate(panel=>{
      const row=document.createElement('div');row.dataset.id='empty';row.innerHTML='<a role="button" download="empty.txt" title=\'Download "empty.txt"\'>Empty</a>';
      row.firstElementChild.href=URL.createObjectURL(new Blob([],{type:'application/octet-stream'}));panel.append(row);
    });return {};
  },'add-empty-download');
  const partial=await f.run(['download','--chat','Team A','--all','--out',out]);
  assert.equal(partial.exitCode,2);assert.equal(partial.ok,false);assert.equal(partial.data.partial,true);
  assert.equal(partial.data.requested,2);assert.equal(partial.data.processed,2);assert.equal(partial.data.failed,1);
  assert.equal(partial.data.results[1].error.code,'EMPTY_DOWNLOAD');
  const manifest=JSON.parse(await fs.readFile(path.join(out,'wa-manifest.json'),'utf8'));
  assert.equal(manifest.files.length,1);
  assert.equal(await transport.act(f.config,async page=>page.evaluate(()=>window.sent),'sent'),0);
  const opened=await f.run(['links','--chat','Team A','--open','https://docs.example.test/sheet?gid=42#part']);
  assert.equal(opened.exitCode,0,JSON.stringify(opened));
  const pages=await transport.act(f.config,async page=>page.context().pages().map(tab=>tab.url()),'opened-link');
  assert.deepEqual(pages,['https://web.whatsapp.com/','https://docs.example.test/sheet?gid=42#part']);
});

test('The actual CLI hands exact file bytes to the native chooser without sending', {timeout:90000},async t=>{
  const f=await fixture(t),file=path.join(f.directory,'upload.txt');await fs.writeFile(file,payload);
  const result=await f.run(['upload','--chat','Team A','--file',file]);
  assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(result.data.status,'files_staged');
  const observed=await transport.act(f.config,async page=>page.locator('#file-input').evaluate(async input=>({
    name:input.files[0].name,bytes:Array.from(new Uint8Array(await input.files[0].arrayBuffer())),sent:window.sent,choosers:window.choosers
  })),'observe-upload');
  assert.equal(observed.name,'upload.txt');assert.deepEqual(Buffer.from(observed.bytes),Buffer.from(payload));
  assert.equal(observed.sent,0);assert.equal(observed.choosers,1);
});

test('Upload retry recovers its pending native chooser and rejects another chat or changed file', {timeout:120000},async t=>{
  const f=await fixture(t),file=path.join(f.directory,'upload.txt');await fs.writeFile(file,payload);
  const interrupted={...f.backend,runCli:async(config,args,...rest)=>{
    if(args[0]==='upload')throw Object.assign(Error('Synthetic command interruption before file handoff'),{code:'COMMAND_TIMEOUT'});
    return transport.runCli(config,args,...rest);
  }};
  await assert.rejects(main(['upload','--chat','Team A','--file',file],interrupted),{code:'COMMAND_TIMEOUT'});
  const pending=await fs.readFile(path.join(f.config.base,'pending-upload.json'),'utf8');
  // Read-only tab metadata must expose the existing modal state in this backend.
  assert.match((await transport.runCli(f.config,['tab-list'])).stdout,/\[File chooser\]/);
  const wrong=await f.run(['upload','--chat','Another chat','--file',file]);
  assert.equal(wrong.error.code,'UNBOUND_FILE_CHOOSER');
  assert.equal(await fs.readFile(path.join(f.config.base,'pending-upload.json'),'utf8'),pending);
  await fs.writeFile(file,'changed original');
  assert.equal((await f.run(['upload','--chat','Team A','--file',file])).error.code,'UPLOAD_CHANGED');
  await fs.writeFile(file,payload);
  const recovered=await f.run(['upload','--chat','Team A','--file',file]);
  assert.equal(recovered.exitCode,0,JSON.stringify(recovered));assert.equal(recovered.data.status,'files_staged');
  const observed=await transport.act(f.config,async page=>page.locator('#file-input').evaluate(async input=>({bytes:Array.from(new Uint8Array(await input.files[0].arrayBuffer())),choosers:window.choosers,sent:window.sent})),'recovered-bytes');
  assert.deepEqual(Buffer.from(observed.bytes),Buffer.from(payload));assert.equal(observed.choosers,1);assert.equal(observed.sent,0);
  await assert.rejects(fs.access(path.join(f.config.base,'pending-upload.json')),{code:'ENOENT'});
});

test('Upload retry verifies a preview left after file handoff without opening a second chooser', {timeout:90000},async t=>{
  const f=await fixture(t),file=path.join(f.directory,'upload.txt');await fs.writeFile(file,payload);
  const interrupted={...f.backend,runCli:async(config,args,...rest)=>{
    const result=await transport.runCli(config,args,...rest);
    if(args[0]==='upload')throw Object.assign(Error('Synthetic lost reply after file handoff'),{code:'COMMAND_TIMEOUT'});
    return result;
  }};
  await assert.rejects(main(['upload','--chat','Team A','--file',file],interrupted),{code:'COMMAND_TIMEOUT'});
  const recovered=await f.run(['upload','--chat','Team A','--file',file]);
  assert.equal(recovered.exitCode,0,JSON.stringify(recovered));assert.equal(recovered.data.recoveredPreview,true);
  const observed=await transport.act(f.config,async page=>page.locator('#file-input').evaluate(async input=>({bytes:Array.from(new Uint8Array(await input.files[0].arrayBuffer())),choosers:window.choosers,sent:window.sent})),'preview-bytes');
  assert.deepEqual(Buffer.from(observed.bytes),Buffer.from(payload));assert.equal(observed.choosers,1);assert.equal(observed.sent,0);
  await assert.rejects(fs.access(path.join(f.config.base,'pending-upload.json')),{code:'ENOENT'});
});

test('The executable returns a nonzero exit with structured JSON for an invalid command',async()=>{
  const result=await invoke(['unknown-test-command']);
  assert.equal(result.exitCode,1);assert.equal(result.ok,false);assert.equal(result.error.code,'UNKNOWN_COMMAND');
});

test('Doctor executes the backend and refuses an existing but broken entrypoint',async()=>{
  const entry=path.join(root,'broken-backend.mjs');await fs.writeFile(entry,"import './implementation-is-missing.mjs';\n");
  const previousEntry=process.env.WA_PLAYWRIGHT_CLI;
  process.env.WA_PLAYWRIGHT_CLI=entry;
  try{
    const result=await invoke(['doctor']);
    assert.equal(result.exitCode,1);assert.equal(result.ok,false);assert.equal(result.error.code,'CLI_UNHEALTHY');
  }finally{if(previousEntry===undefined)delete process.env.WA_PLAYWRIGHT_CLI;else process.env.WA_PLAYWRIGHT_CLI=previousEntry;}
});
