import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {main,stageFiles,verifyFiles} from '../scripts/wa.mjs';
import {browserAction} from '../scripts/browser.mjs';
import {playwrightModule} from '../scripts/transport.mjs';
import {checkRequirements} from '../scripts/platform.mjs';

const root=fileURLToPath(new URL('../.work/cli-tests/',import.meta.url));
await fs.mkdir(root,{recursive:true});
const runRoot=await fs.mkdtemp(path.join(root,'run-'));
after(async()=>{
  if(path.dirname(runRoot)!==path.resolve(root))throw new Error('Unexpected fixture cleanup path');
  await fs.rm(runRoot,{recursive:true,force:true});
});
async function fixture(){
  const base=await fs.mkdtemp(path.join(runRoot,'case-'));
  const config={base,cwd:path.join(base,'runtime'),profile:path.join(base,'profile'),session:'fixture',lock:path.join(base,'command.lock')};
  const log=[],state={profile:config.profile,open:true,headed:false,uncertain:false,checked:false,external:false,browserCalls:0,browserUnavailable:false};
  const browserAccess=()=>{state.browserCalls++;assert.equal(state.browserUnavailable,false,'Unexpected browser access');};
  const backend={settings:()=>config,findCli:async()=>{browserAccess();return '';},sessionInfo:async()=>{browserAccess();return {open:state.open,profile:state.profile,headed:state.headed};},snapshot:async()=>{browserAccess();return {snapshot:'fixture'};},
    openBrowser:async(c,{headed})=>{browserAccess();log.push({cli:['open','https://web.whatsapp.com/','--browser=chrome',...(headed?['--headed']:[]),`--profile=${c.profile}`]});},
    closeBrowser:async()=>{browserAccess();log.push({cli:['close']});state.open=false;},
    runCli:async(c,args)=>{browserAccess();log.push({cli:args});return {stdout:args[0]==='tab-list'?'- 0: [WhatsApp](https://web.whatsapp.com/)\n- 1: (current) [Link](https://example.test/)':''};},
    act:async(c,fn,op,args)=>{
      browserAccess();
      log.push({op,args});
      if(op==='status'){if(state.external){state.external=false;throw Object.assign(Error('external tab'),{code:'WRONG_ORIGIN'});}return {authenticated:true};}
      if(op==='compose')return {sent:false};
      if(op==='upload')return {filesSet:true};
      if(op==='verify-upload')return {status:'files_staged',files:args.files,sent:false};
      if(op==='guard')return {chat:args.chat};
      if(op==='prepare-send')return {before:['old-message'],confirmation:{version:1,anchorId:'old-message',atLatest:true}};
      if(op==='send'){state.attemptAtSend=JSON.parse(await fs.readFile(path.join(base,'prepared-draft.json'),'utf8')).attempt;if(state.uncertain)throw Object.assign(Error('backend disconnected'),{code:'BROWSER_ERROR'});return {status:state.unresolved?'send_unresolved':'outgoing_message_observed',messages:[{messageId:'new-message'}]};}
      if(op==='send-check')return state.checked?{status:'outgoing_message_observed',messages:[{messageId:'new-message'}]}:{status:'send_unresolved'};
      assert.fail('Unexpected browser operation: '+op);
    }};
  return {config,log,state,backend,run:args=>main(args,backend),prepared:path.join(base,'prepared-draft.json')};
}

test('Every staged file keeps its bytes when basenames and generated collision names overlap',async()=>{
  const f=await fixture(),originals=[];
  for(const [i,name] of ['2-a.txt','a.txt','a.txt','a (1).txt','A.TXT'].entries()){
    const dir=path.join(f.config.base,'source-'+i);await fs.mkdir(dir);const file=path.join(dir,name);await fs.writeFile(file,'file '+i);originals.push(file);
  }
  const staged=await stageFiles(f.config,'Team A',originals);
  assert.equal(new Set(staged.staged.map(s=>s.toLowerCase())).size,originals.length);
  for(let i=0;i<originals.length;i++)assert.deepEqual(await fs.readFile(staged.staged[i]),await fs.readFile(originals[i]));
});

test('Recovery detects changes in both original files and private staging copies',async()=>{
  const f=await fixture(),file=path.join(f.config.base,'file.txt');await fs.writeFile(file,'original');
  const staged=await stageFiles(f.config,'Team A',[file]);
  await fs.writeFile(staged.staged[0],'tampered');await assert.rejects(verifyFiles(staged),{code:'UPLOAD_CHANGED'});
  await fs.writeFile(staged.staged[0],'original');await fs.writeFile(file,'new revision');await assert.rejects(verifyFiles(staged),{code:'UPLOAD_CHANGED'});
});

test('Send rechecks prepared source and staged bytes before recording or activating an attempt',async()=>{
  for(const target of ['originals','staged']){
    const f=await fixture(),file=path.join(f.config.base,'file.txt');await fs.writeFile(file,'original');
    await f.run(['upload','--chat','Team A','--file',file]);
    const prepared=await fs.readFile(f.prepared,'utf8'),saved=JSON.parse(prepared);
    await fs.writeFile(saved[target][0],'modified');
    await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'UPLOAD_CHANGED'});
    assert.equal(await fs.readFile(f.prepared,'utf8'),prepared);
    assert.equal(f.log.filter(entry=>entry.op==='prepare-send'||entry.op==='send').length,0);
  }
});

test('Inapplicable flags and extra positional arguments fail before browser access',async()=>{
  const f=await fixture();
  await assert.rejects(f.run(['messages','--chat','Team A','--open','https://example.test/']),{code:'BAD_ARGUMENT'});
  await assert.rejects(f.run(['send','unexpected','--chat','Team A','--authorized']),{code:'BAD_ARGUMENT'});
  assert.deepEqual(f.log,[]);
});

test('Sending requires readable preparation metadata for the selected chat',async()=>{
  const f=await fixture();
  await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'DRAFT_NOT_PREPARED'});
  await fs.writeFile(f.prepared,'broken json');
  await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'STATE_INVALID'});
  await fs.writeFile(f.prepared,JSON.stringify({chat:'Someone else',kind:'text',text:'hello'}));
  await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'DRAFT_MISMATCH'});
  assert.equal(f.log.filter(e=>e.op==='send').length,0);
});

test('An interrupted send is persisted, cannot be repeated, and can be checked without sending',async()=>{
  const f=await fixture(),file=path.join(f.config.base,'text.txt');await fs.writeFile(file,'Prepared text');
  await f.run(['compose','--chat','Team A','--text-file',file]);
  f.state.uncertain=true;
  await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'SEND_UNCERTAIN'});
  const recorded=JSON.parse(await fs.readFile(f.prepared,'utf8'));
  assert.ok(recorded.attempt.at);
  assert.deepEqual(recorded.attempt.confirmation,{version:1,anchorId:'old-message',atLatest:true});
  assert.deepEqual(f.state.attemptAtSend,recorded.attempt,'Recovery evidence must be durable before Send can be activated');
  await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'SEND_UNCERTAIN'});
  assert.equal(f.log.filter(e=>e.op==='send').length,1);
  assert.equal((await f.run(['send-check','--chat','Team A'])).status,'send_unresolved');
  const check=f.log.find(e=>e.op==='send-check');
  assert.deepEqual(check.args.before,recorded.attempt.before);
  assert.deepEqual(check.args.confirmation,recorded.attempt.confirmation);
  assert.deepEqual(JSON.parse(await fs.readFile(f.prepared,'utf8')),recorded);
  f.state.checked=true;assert.equal((await f.run(['send-check','--chat','Team A'])).messages[0].messageId,'new-message');
  await assert.rejects(fs.access(f.prepared),{code:'ENOENT'});
  assert.equal(f.log.filter(e=>e.op==='send').length,1);
});

test('An unconfirmed send response preserves the attempt and blocks another activation',async()=>{
  const f=await fixture(),file=path.join(f.config.base,'text.txt');await fs.writeFile(file,'Prepared text');
  await f.run(['compose','--chat','Team A','--text-file',file]);
  f.state.unresolved=true;
  await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'SEND_UNCERTAIN'});
  const pending=await fs.readFile(f.prepared,'utf8');
  await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'SEND_UNCERTAIN'});
  assert.equal(await fs.readFile(f.prepared,'utf8'),pending);
  assert.equal(f.log.filter(e=>e.op==='send').length,1);
});

test('Loading historical outgoing text cannot clear an uncertain attempt through the CLI',async()=>{
  const f=await fixture();
  const server=createServer((_request,response)=>response.end('<div id="side"></div><div id="main"><header>Team A</header><div data-testid="conversation-panel-messages" style="height:200px;overflow:auto"><div data-id="old-history" class="message-out"><span data-pre-plain-text="[10:00, 1/1/2020] Test: "></span><span data-testid="selectable-text">Repeated message</span></div><div data-id="recent-message"><span data-testid="selectable-text">Recent baseline</span></div></div><footer><div role="textbox" contenteditable="true"></div></footer></div>'));
  let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const {chromium}=await playwrightModule(),{chrome}=await checkRequirements();
    browser=await chromium.launch({channel:'chrome',executablePath:chrome,headless:true});
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    f.backend.act=(_config,_function,operation,args)=>browserAction(page,operation,{...args,fixture:true});
    for(const confirmation of [undefined,{version:1,anchorId:'recent-message',atLatest:true}]){
      const prepared={chat:'Team A',kind:'text',text:'Repeated message',attempt:{at:'2026-09-12T12:00:00.000Z',before:['recent-message'],confirmation}};
      const original=JSON.stringify(prepared);await fs.writeFile(f.prepared,original);
      assert.equal((await f.run(['send-check','--chat','Team A'])).status,'send_unresolved');
      assert.equal(await fs.readFile(f.prepared,'utf8'),original);
      await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'SEND_UNCERTAIN'});
    }
  }finally{await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));}
});

test('Unresolved sends block text and file preparation across chats without changing the attempt',async()=>{
  const f=await fixture(),file=path.join(f.config.base,'text.txt');await fs.writeFile(file,'Prepared text');
  await f.run(['compose','--chat','Team A','--text-file',file]);
  f.state.uncertain=true;
  await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'SEND_UNCERTAIN'});
  const original=await fs.readFile(f.prepared,'utf8'),before=f.state.browserCalls;
  f.state.browserUnavailable=true;
  for(const chat of ['Team A','Another team']) {
    for(const args of [['compose','--text-file',file],['upload','--file',file],['ui','upload','--file',file]]) {
      await assert.rejects(f.run([...args,'--chat',chat]),{code:'SEND_UNCERTAIN'});
      assert.equal(await fs.readFile(f.prepared,'utf8'),original);
    }
  }
  assert.equal(f.state.browserCalls,before);
  assert.equal(f.log.filter(e=>e.op==='send').length,1);
  await assert.rejects(fs.access(path.join(f.config.cwd,'uploads')),{code:'ENOENT'});
});

test('Manual resolution requires an inspected outcome, the exact chat and an existing attempt',async()=>{
  const f=await fixture();f.state.browserUnavailable=true;
  const prepared={chat:'Team A',kind:'text',text:'Prepared text',attempt:{at:'2026-09-12T00:00:00.000Z',before:['old-message']}};
  await fs.writeFile(f.prepared,JSON.stringify(prepared));
  for(const [args,code] of [
    [['send-resolve','--chat','Team A','--outcome','sent'],'INSPECTION_REQUIRED'],
    [['send-resolve','--chat','Team A','--inspected'],'BAD_ARGUMENT'],
    [['send-resolve','--chat','Team A','--outcome','unknown','--inspected'],'BAD_ARGUMENT'],
    [['send-resolve','--outcome','sent','--inspected'],'CHAT_REQUIRED'],
    [['send-resolve','--chat','team a','--outcome','sent','--inspected'],'DRAFT_MISMATCH'],
    [['send-resolve','--chat','Team A','--outcome','sent','--inspected','--authorized'],'BAD_ARGUMENT']
  ]) {
    await assert.rejects(f.run(args),{code});
    assert.deepEqual(JSON.parse(await fs.readFile(f.prepared,'utf8')),prepared);
  }
  await assert.rejects(fs.access(path.join(f.config.base,'send-resolutions')),{code:'ENOENT'});
  delete prepared.attempt;await fs.writeFile(f.prepared,JSON.stringify(prepared));
  await assert.rejects(f.run(['send-resolve','--chat','Team A','--outcome','sent','--inspected']),{code:'NO_SEND_ATTEMPT'});
  assert.deepEqual(JSON.parse(await fs.readFile(f.prepared,'utf8')),prepared);
  await fs.rm(f.prepared);
  await assert.rejects(f.run(['send-resolve','--chat','Team A','--outcome','not-sent','--inspected']),{code:'NO_SEND_ATTEMPT'});
  assert.equal(f.state.browserCalls,0);
});

test('Manual resolution records the inspected conclusion offline and permits intentional preparation without sending',async()=>{
  for(const outcome of ['sent','not-sent']) {
    const f=await fixture(),file=path.join(f.config.base,'text.txt');await fs.writeFile(file,'Prepared text');
    await f.run(['compose','--chat','Team A','--text-file',file]);
    f.state.uncertain=true;
    await assert.rejects(f.run(['send','--chat','Team A','--authorized']),{code:'SEND_UNCERTAIN'});
    const attempted=JSON.parse(await fs.readFile(f.prepared,'utf8'));
    const before=f.state.browserCalls;f.state.browserUnavailable=true;
    const result=await f.run(['send-resolve','--chat','Team A','--outcome',outcome,'--inspected']);
    assert.equal(result.status,'send_resolved_manually');
    assert.equal(result.outcome,outcome);assert.equal(result.automatedDeliveryVerification,false);
    assert.equal(path.dirname(result.receiptPath),path.join(f.config.base,'send-resolutions'));
    const receipt=JSON.parse(await fs.readFile(result.receiptPath,'utf8'));
    assert.equal(receipt.chat,'Team A');assert.equal(receipt.outcome,outcome);
    assert.equal(receipt.attemptedAt,attempted.attempt.at);
    assert.equal(receipt.basis,'manual_ui_history_inspection');
    assert.equal(receipt.automatedDeliveryVerification,false);
    assert.ok(Number.isFinite(Date.parse(receipt.resolvedAt)));
    await assert.rejects(fs.access(f.prepared),{code:'ENOENT'});
    assert.equal(f.state.browserCalls,before);
    await assert.rejects(f.run(['send-resolve','--chat','Team A','--outcome',outcome,'--inspected']),{code:'NO_SEND_ATTEMPT'});
    assert.equal((await fs.readdir(path.dirname(result.receiptPath))).length,1);
    f.state.browserUnavailable=false;
    await f.run(outcome==='sent'?['compose','--chat','Another team','--text-file',file]:['upload','--chat','Another team','--file',file]);
    const next=JSON.parse(await fs.readFile(f.prepared,'utf8'));
    assert.equal(next.chat,'Another team');assert.equal(next.attempt,undefined);
    assert.equal(next.kind,outcome==='sent'?'text':'files');
    assert.equal(f.log.filter(e=>e.op==='send').length,1);
    await assert.rejects(f.run(['send','--chat','Another team']),{code:'SEND_AUTHORIZATION'});
    assert.equal(f.log.filter(e=>e.op==='send').length,1);
  }
});

test('A failed resolution receipt write preserves the unresolved attempt',async()=>{
  const f=await fixture();f.state.browserUnavailable=true;
  const prepared={chat:'Team A',kind:'text',text:'Prepared text',attempt:{at:'2026-09-12T00:00:00.000Z',before:[]}};
  await fs.writeFile(f.prepared,JSON.stringify(prepared));
  await fs.writeFile(path.join(f.config.base,'send-resolutions'),'Blocking fixture file');
  await assert.rejects(f.run(['send-resolve','--chat','Team A','--outcome','not-sent','--inspected']));
  assert.deepEqual(JSON.parse(await fs.readFile(f.prepared,'utf8')),prepared);
  assert.equal(f.state.browserCalls,0);
});

test('Open reselects an existing WhatsApp tab; close refuses an unrelated profile',async()=>{
  const f=await fixture();f.state.external=true;
  assert.equal((await f.run(['open'])).reused,true);
  assert.deepEqual(f.log.filter(e=>e.cli).map(e=>e.cli),[['tab-list'],['tab-select','0']]);
  f.log.length=0;f.state.profile=path.join(f.config.base,'another-profile');
  await assert.rejects(f.run(['close']),{code:'PROFILE_MISMATCH'});assert.deepEqual(f.log,[]);
});

test('Open recovers a completed close before deciding whether to reuse the daemon',async()=>{
  const f=await fixture(),order=[];
  f.backend.recoverClosedBrowser=async config=>{assert.equal(config,f.config);order.push('recover');f.state.open=false;};
  const info=f.backend.sessionInfo;
  f.backend.sessionInfo=async config=>{order.push('inspect');return info(config);};
  const result=await f.run(['open']);
  assert.deepEqual(order,['recover','inspect']);
  assert.equal(result.reused,false);assert.equal(result.profile,f.config.profile);
  assert.equal(f.log.filter(e=>e.cli?.[0]==='open').length,1);
  f.backend.recoverClosedBrowser=async()=>{throw Object.assign(Error('Unconfirmed shutdown'),{code:'BROWSER_CLOSE_PENDING'});};
  const calls=f.state.browserCalls;
  await assert.rejects(f.run(['open']),{code:'BROWSER_CLOSE_PENDING'});
  assert.equal(f.state.browserCalls,calls);
});

test('Closed sessions launch in the background by default, with the same profile in visible mode',async()=>{
  for(const headed of [false,true]){
    const f=await fixture();f.state.open=false;
    const result=await f.run(['open',...(headed?['--headed']:[])]);
    const args=f.log.find(e=>e.cli)?.cli;
    assert.equal(result.headed,headed);assert.equal(result.reused,false);
    assert.equal(args.includes('--headed'),headed);
    assert.ok(args.includes(`--profile=${f.config.profile}`));
    assert.ok(!f.log.some(e=>e.op==='send'));
  }
});

test('Reusing a visible session preserves its mode and draft rather than restarting it',async()=>{
  const f=await fixture();f.state.headed=true;
  const prepared=JSON.stringify({chat:'Team A',kind:'text',text:'Keep this draft'});
  await fs.writeFile(f.prepared,prepared);
  assert.equal((await f.run(['open'])).headed,true);
  assert.equal((await f.run(['status'])).headed,true);
  assert.equal(f.log.filter(e=>e.cli).length,0);
  assert.equal(await fs.readFile(f.prepared,'utf8'),prepared);
});

test('Requesting a visible window does not silently restart a background session',async()=>{
  const f=await fixture();
  await assert.rejects(f.run(['open','--headed']),{code:'BROWSER_MODE'});
  await assert.rejects(f.run(['messages','--chat','Team A','--headed']),{code:'BAD_ARGUMENT'});
  assert.deepEqual(f.log,[]);
});
