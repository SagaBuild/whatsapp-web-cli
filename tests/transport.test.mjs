import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {settings,findCli,runCli,parseResult,act,snapshot,sessionInfo,openBrowser,closeBrowser,recoverClosedBrowser} from '../scripts/transport.mjs';
import {createBrowserFixture} from './helpers/browser-fixture.mjs';

// Chrome's IndexedDB backing store is sensitive to deeply nested Windows paths.
const scratch=await fs.realpath(os.tmpdir());
const root=await fs.mkdtemp(path.join(scratch,'wa-transport-'));
const browsers=[];
after(async()=>{
  assert.ok(browsers.every(browser=>browser.cleaned),'Retain the private registry until every synthetic browser exits.');
  assert.equal(path.dirname(await fs.realpath(root)),scratch);
  await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
});
const fixtureDir=await fs.mkdtemp(path.join(root,'backend-'));
const fixture=path.join(fixtureDir,'backend.mjs');
const require=createRequire(import.meta.url);
const registry=path.join(path.dirname(require.resolve('playwright-core/package.json')),'lib','tools','cli-client','registry.js');
await fs.writeFile(fixture,`
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
const args=process.argv.slice(2),mode=args[1];
if(mode==='unicode') {
  for(const stream of [process.stdout,process.stderr])for(const byte of Buffer.from('### Result\\n'+JSON.stringify({value:'挪威语 💬 Café',args})+'\\n')) {
    stream.write(Buffer.from([byte])); await delay(3);
  }
} else if(mode==='backend-error') {
  process.stdout.write('### Error\\nSynthetic backend failure\\n');
} else if(mode==='exit-error') {
  process.stderr.write('Synthetic process failure');process.exitCode=7;
} else if(mode==='hang') {
  await delay(60000);
} else if(mode==='run-code') {
  const code=args[2].startsWith('--filename=')?await fs.readFile(args[2].slice('--filename='.length),'utf8'):args[2];
  console.log('### Result\\n'+JSON.stringify(await (0,eval)('('+code+')')({})));
} else if(mode==='identity') {
  const {createClientInfo}=createRequire(import.meta.url)(${JSON.stringify(registry)});
  console.log('### Result\\n'+JSON.stringify(createClientInfo()));
} else if(mode==='list') {
  console.log(JSON.stringify({browsers:[
    {name:'unrelated',status:'open',userDataDir:'wrong'},
    {name:args[0].slice(3),status:'open',userDataDir:process.env.WA_TEST_PROFILE,headed:false,compatible:true,persistent:true,attached:false}
  ]}));
} else {
  throw new Error('Unexpected fixture mode: '+mode);
}
`);

async function isolated(t) {
  const dir=await fs.mkdtemp(path.join(root,'runtime-'));
  const updates={WA_PLAYWRIGHT_CLI:fixture,WA_DATA_DIR:dir,PWTEST_DAEMON_SESSION_DIR:path.join(dir,'daemon'),PWTEST_SERVER_REGISTRY:path.join(dir,'servers'),NO_UPDATE_NOTIFIER:'1'};
  for(const [name,value] of Object.entries(updates)) {
    const previous=process.env[name];process.env[name]=value;
    t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous;});
  }
  return settings('fixture');
}

function browserFixture(t,config){
  const browser=createBrowserFixture(config,{root});
  browsers.push(browser);
  // A separate hook preserves a failing test's original error and does not use
  // closeBrowser, which may be the broken function that caused the failure.
  t.after(()=>browser.cleanup());
  return browser;
}

async function syntheticBackend(config,name,code){
  await fs.mkdir(config.cwd,{recursive:true});
  const file=path.join(config.cwd,name+'.mjs');
  await fs.writeFile(file,code);
  process.env.WA_PLAYWRIGHT_CLI=file;
}

async function lostCloseResponseBackend(config){
  const actual=require.resolve('@playwright/cli/playwright-cli.js');
  const wrapper=path.join(config.base,'fault-backend.mjs'),flag=path.join(config.base,'drop-close-response');
  const failList=path.join(config.base,'fail-list-once'),reply=path.join(config.base,'completed-close-reply.txt');
  const calls=path.join(config.base,'backend-calls.jsonl');
  await fs.mkdir(config.base,{recursive:true});
  await fs.writeFile(wrapper,`
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
await fs.appendFile(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
let fault;
if(args[1]==='list'){
  try{await fs.unlink(${JSON.stringify(failList)});fault='fail-list';}catch{}
}
if(fault==='fail-list'){
  console.error('Synthetic recovery interruption');process.exitCode=7;
}else{
  if(args[1]==='run-code'){
    const command=args.find(arg=>arg.startsWith('--filename='));
    if(command&&(await fs.readFile(command.slice('--filename='.length),'utf8')).includes('"close-browser"')){
      try{fault=await fs.readFile(${JSON.stringify(flag)},'utf8');await fs.unlink(${JSON.stringify(flag)});}catch{}
    }
  }
  const child=spawn(process.execPath,[${JSON.stringify(actual)},...args],{cwd:process.cwd(),env:process.env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',text=>stdout+=text);child.stderr.on('data',text=>stderr+=text);
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('close',async code=>{
    if(fault&&code===0){
      await fs.writeFile(${JSON.stringify(reply)},stdout);
      if(fault==='interrupt-recovery')await fs.writeFile(${JSON.stringify(failList)},'fail once');
      process.stdout.write('### Page\\nSynthetic lost completed shutdown result\\n');
    }else process.stdout.write(stdout);
    process.stderr.write(stderr);process.exitCode=code;
  });
}
`);
  process.env.WA_PLAYWRIGHT_CLI=wrapper;
  return {flag,reply,calls};
}

test('An explicit missing backend fails instead of falling through to another installation',async t=>{
  await isolated(t);
  process.env.WA_PLAYWRIGHT_CLI=path.join(fixtureDir,'missing.mjs');
  await assert.rejects(findCli(),{code:'CLI_MISSING'});
});

test('CLI output and argv preserve Unicode across byte boundaries',async t=>{
  const config=await isolated(t);
  const args=['unicode','聊天 💬','quote " and literal $()'];
  const result=await runCli(config,args);
  assert.equal(parseResult(result.stdout).value,'挪威语 💬 Café');
  assert.equal(parseResult(result.stderr).value,'挪威语 💬 Café');
  assert.deepEqual(parseResult(result.stdout).args,[`-s=${config.session}`,...args]);
});

test('Backend errors and timeouts do not become successful command results',async t=>{
  const config=await isolated(t);
  await assert.rejects(runCli(config,['backend-error']),{code:'BROWSER_ERROR',message:'Synthetic backend failure\n'});
  await assert.rejects(runCli(config,['exit-error']),{code:'BROWSER_ERROR',message:'Synthetic process failure'});
  await assert.rejects(runCli(config,['hang'],75),{code:'COMMAND_TIMEOUT'});
});

test('Structured actions roundtrip values and preserve reported errors',async t=>{
  const config=await isolated(t);
  const args={chat:'团队 💬',text:'Exact\nmessage'};
  assert.deepEqual(await act(config,async(_page,operation,values)=>({operation,values}),'read',args),{operation:'read',values:args});
  await assert.rejects(act(config,async()=>{throw Object.assign(new Error('Missing 团队'),{code:'WRONG_CHAT',details:{chat:'团队'}});},'guard'),{code:'WRONG_CHAT',message:'Missing 团队',details:{chat:'团队'}});
  assert.throws(()=>parseResult('no structured result'),{code:'RESULT_MISSING'});
  assert.throws(()=>parseResult('### Result\nnot JSON\n### Page\n'),{code:'RESULT_INVALID'});
});

test('Valid JSON with a malformed action envelope cannot become a successful result',async t=>{
  const config=await isolated(t);
  for(const envelope of [{},null,[],'unwrapped result',42,{unrelated:true}]){
    await syntheticBackend(config,'malformed-action',`console.log('### Result\\n'+${JSON.stringify(JSON.stringify(envelope))});`);
    await assert.rejects(act(config,async()=>true,'fixture'),{code:'RESULT_INVALID'});
  }
});

test('Snapshot requests cannot return stale content when the backend omits a new file',async t=>{
  const config=await isolated(t),file=path.join(config.cwd,'.wa-snapshot.yml');
  await syntheticBackend(config,'missing-snapshot',`console.log('### Page\\nSynthetic backend omitted the snapshot');`);
  await fs.writeFile(file,'previous chat snapshot');
  await assert.rejects(snapshot(config),{code:'ENOENT'});
  await syntheticBackend(config,'chooser-snapshot',`console.log('### Modal state\\n- [File chooser]:');`);
  await fs.writeFile(file,'previous chat snapshot');
  assert.deepEqual(await snapshot(config),{snapshot:'',fileChooserPending:true});
  await syntheticBackend(config,'fresh-snapshot',`import fs from 'node:fs/promises';
const file=process.argv.find(arg=>arg.startsWith('--filename=')).slice('--filename='.length);
await fs.writeFile(file,'current chat snapshot');console.log('### Page\\nSynthetic fresh snapshot');`);
  assert.deepEqual(await snapshot(config),{snapshot:'current chat snapshot',fileChooserPending:false});
});

test('Large quoted Unicode actions use private command files and remove completed commands',async t=>{
  const config=await isolated(t);
  const text='团队 💬 "quoted" \\ and line\n'.repeat(2500);
  assert.equal(await act(config,async(_page,_operation,args)=>args.text,'fixture',{text}),text);
  await assert.rejects(act(config,async()=>{throw new Error('Synthetic completed failure');},'fixture'),{code:'UI_ERROR'});
  assert.deepEqual((await fs.readdir(config.cwd)).filter(file=>file.startsWith('.wa-command-')),[]);
});

test('The pinned backend binds identity to the persistent runtime directory',async t=>{
  const config=await isolated(t);
  const identity=parseResult((await runCli(config,['identity'])).stdout);
  assert.equal(identity.workspaceDir,config.cwd);
  assert.ok(identity.daemonProfilesDir.startsWith(process.env.PWTEST_DAEMON_SESSION_DIR));
});

test('Session metadata selects the exact session from structured backend output',async t=>{
  const config=await isolated(t);
  const previous=process.env.WA_TEST_PROFILE;process.env.WA_TEST_PROFILE=config.profile;
  t.after(()=>{if(previous===undefined)delete process.env.WA_TEST_PROFILE;else process.env.WA_TEST_PROFILE=previous;});
  const info=await sessionInfo(config);
  assert.equal(info.known,true);
  assert.equal(info.open,true);
  assert.equal(info.profile,config.profile);
  assert.equal(info.headed,false);
});

test('Duplicate exact session names are rejected even when the first record has the expected profile',async t=>{
  const config=await isolated(t);
  const first={name:config.session,status:'open',userDataDir:config.profile};
  await syntheticBackend(config,'duplicate-sessions',`console.log(${JSON.stringify(JSON.stringify({browsers:[first,{...first,userDataDir:path.join(config.base,'other-profile')}]}))});`);
  await assert.rejects(sessionInfo(config),{code:'SESSION_AMBIGUOUS'});
  await syntheticBackend(config,'no-session',`console.log(${JSON.stringify(JSON.stringify({browsers:[{...first,name:'another-session'}]}))});`);
  assert.deepEqual(await sessionInfo(config),{open:false,known:false});
});

test('The actual pinned CLI launches the detected Chrome and reopens only its isolated persistent profile',async t=>{
  const config=await isolated(t);
  process.env.WA_PLAYWRIGHT_CLI=require.resolve('@playwright/cli/playwright-cli.js');
  const browser=browserFixture(t,config);
  const open=async()=>{await openBrowser(config,{url:'about:blank'});await browser.record();};
  const persistedStorage=async(page,_operation,{write=false}={})=>{
    await page.route('https://transport.fixture.test/**',route=>route.fulfill({contentType:'text/html',body:'<title>Synthetic profile</title>'}));
    await page.goto('https://transport.fixture.test/');
    return page.evaluate(async write=>{
      if(write)localStorage.setItem('fixture','synthetic-local-storage');
      const database=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('fixture',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('state');
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      try{
        const indexed=await new Promise((resolve,reject)=>{
          const transaction=database.transaction('state',write?'readwrite':'readonly'),store=transaction.objectStore('state');
          if(write)store.put('synthetic-indexed-db','fixture');
          const request=store.get('fixture');
          transaction.oncomplete=()=>resolve(request.result);
          transaction.onabort=()=>reject(transaction.error);transaction.onerror=()=>reject(transaction.error);
        });
        return {local:localStorage.getItem('fixture'),indexed};
      }finally{database.close();}
    },write);
  };
    await open();
    assert.equal((await sessionInfo(config)).profile,config.profile);
    assert.equal((await sessionInfo(config)).headed,false);
    const cookieValue='synthetic-persistence-check';
    assert.deepEqual(await act(config,async(page,_operation,args)=>{
      await page.context().addCookies([{name:'fixture',value:args.cookieValue,url:'https://transport.fixture.test',expires:Math.floor(Date.now()/1000)+3600}]);
      return {url:page.url(),title:'团队 💬'};
    },'fixture',{cookieValue}),{url:'about:blank',title:'团队 💬'});
    const text='团队 💬 "quoted" \\ and line\n'.repeat(1800);
    assert.equal(await act(config,async(page,_operation,args)=>{
      await page.setContent('<textarea></textarea>');
      await page.locator('textarea').fill(args.text);
      return await page.locator('textarea').inputValue();
    },'fixture',{text}),text);
    await assert.rejects(runCli(config,['run-code','async () => { throw new Error("Synthetic backend failure"); }']),{code:'BROWSER_ERROR'});
    await closeBrowser(config);
    assert.equal((await sessionInfo(config)).open,false);
    await open();
    assert.equal((await sessionInfo(config)).profile,config.profile);
    assert.equal((await sessionInfo(config)).headed,false);
    const cookies=await act(config,async page=>page.context().cookies('https://transport.fixture.test'),'fixture');
    assert.equal(cookies.find(cookie=>cookie.name==='fixture')?.value,cookieValue);
    // Keep the original cookie-only regression separate from visiting its origin.
    const savedStorage={local:'synthetic-local-storage',indexed:'synthetic-indexed-db'};
    assert.deepEqual(await act(config,persistedStorage,'fixture',{write:true}),savedStorage);
    await closeBrowser(config);
    await open();
    assert.deepEqual(await act(config,persistedStorage,'fixture'),savedStorage);
});

test('A lost completed shutdown reply recovers the idle daemon and preserves its persistent cookie',async t=>{
  const config=await isolated(t),fault=await lostCloseResponseBackend(config);
  const browser=browserFixture(t,config);
    await openBrowser(config,{url:'about:blank'});
    await browser.record();
    await act(config,async page=>{
      await page.context().addCookies([{name:'lost-reply',value:'synthetic-persistent-cookie',url:'https://transport.fixture.test',expires:Math.floor(Date.now()/1000)+3600}]);
      return {saved:true};
    },'fixture');
    await fs.writeFile(fault.flag,'drop-result');
    assert.deepEqual(await closeBrowser(config),{closed:true,profileRetained:true});
    assert.deepEqual(parseResult(await fs.readFile(fault.reply,'utf8')).value,{browserClosed:true});
    assert.equal((await sessionInfo(config)).open,false);
    await assert.rejects(fs.access(path.join(config.cwd,'.wa-close-completed.json')),{code:'ENOENT'});
    await openBrowser(config,{url:'about:blank'});
    await browser.record();
    const cookies=await act(config,async page=>page.context().cookies('https://transport.fixture.test'),'fixture');
    assert.equal(cookies.find(cookie=>cookie.name==='lost-reply')?.value,'synthetic-persistent-cookie');
});

test('Interrupted shutdown recovery needs no page and an old receipt cannot stop a new daemon for the same profile',async t=>{
  const config=await isolated(t),fault=await lostCloseResponseBackend(config);
  const browser=browserFixture(t,config);
  const receiptFile=path.join(config.cwd,'.wa-close-completed.json');
    await openBrowser(config,{url:'about:blank'});
    await browser.record();
    await fs.writeFile(fault.flag,'interrupt-recovery');
    await assert.rejects(closeBrowser(config),{code:'BROWSER_ERROR',message:'Synthetic recovery interruption\n'});
    assert.deepEqual(parseResult(await fs.readFile(fault.reply,'utf8')).value,{browserClosed:true});
    const receipt=await fs.readFile(receiptFile,'utf8');
    assert.equal((await sessionInfo(config)).open,true,'The closed browser leaves an idle daemon until recovery resumes.');
    const callsBefore=(await fs.readFile(fault.calls,'utf8')).trim().split('\n').length;
    assert.equal(await recoverClosedBrowser(config),true);
    const recoveryCalls=(await fs.readFile(fault.calls,'utf8')).trim().split('\n').slice(callsBefore).map(line=>JSON.parse(line)[1]);
    assert.ok(recoveryCalls.includes('close'));
    assert.equal(recoveryCalls.includes('run-code'),false,'Recovery must work without a browser page.');
    assert.equal((await sessionInfo(config)).open,false);
    await assert.rejects(fs.access(receiptFile),{code:'ENOENT'});
    await openBrowser(config,{url:'about:blank'});
    await browser.record();
    await fs.writeFile(receiptFile,receipt);
    assert.equal(await recoverClosedBrowser(config),false,'A new registration invalidates completion evidence from the previous daemon.');
    assert.equal(await fs.readFile(receiptFile,'utf8'),receipt);
    assert.equal((await sessionInfo(config)).open,true);
    assert.equal(await act(config,async page=>page.url(),'fixture'),'about:blank');
});

test('Independent fixture cleanup stops only its recorded browser after production shutdown fails',async t=>{
  const config=await isolated(t);
  process.env.WA_PLAYWRIGHT_CLI=require.resolve('@playwright/cli/playwright-cli.js');
  const browser=browserFixture(t,config);
  await openBrowser(config,{url:'about:blank'});
  await browser.record();
  const failure=Object.assign(Error('Synthetic incompatible shutdown handler'),{code:'BROWSER_CLOSE_UNSUPPORTED'});
  await assert.rejects(closeBrowser(config,{request:async()=>{throw failure;}}),error=>error===failure);
  assert.equal((await sessionInfo(config)).open,true);
  await browser.cleanup();
  assert.equal(browser.cleaned,true);
  for(const pid of browser.processes)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal((await sessionInfo(config)).open,false);
});

test('Identical registration bytes in a replacement file invalidate authentic shutdown evidence',async t=>{
  const config=await isolated(t);
  const registryFile=path.join(process.env.PWTEST_DAEMON_SESSION_DIR,createHash('sha1').update(config.cwd).digest('hex').slice(0,16),config.session+'.session');
  const text=JSON.stringify({name:config.session,browser:{userDataDir:config.profile},workspaceDir:config.cwd,timestamp:1,socketPath:'synthetic-only'});
  await fs.mkdir(path.dirname(registryFile),{recursive:true});await fs.writeFile(registryFile,text);
  // Let the production close code generate its own receipt in a Node-only
  // backend. No test-side copy of the identity-hashing algorithm is involved.
  await syntheticBackend(config,'synthetic-close',`import fs from 'node:fs/promises';
const command=process.argv.find(arg=>arg.startsWith('--filename='));
const source=await fs.readFile(command.slice('--filename='.length),'utf8');
function backendCloseListener(){return 'deleteSessionFile gracefullyProcessExitDoNotHang';}
const context={listeners:()=>[backendCloseListener],removeListener(){},on(){},async close(){}};
console.log('### Result\\n'+JSON.stringify(await (0,eval)('('+source+')')({context:()=>context})));`);
  let observations=0;
  await assert.rejects(closeBrowser(config,{info:async()=>{
    if(++observations>=3)throw Object.assign(Error('Synthetic recovery interruption'),{code:'FIXTURE_INTERRUPTION'});
    return {open:true,profile:config.profile,workspace:config.cwd};
  }}),{code:'FIXTURE_INTERRUPTION'});
  const receiptFile=path.join(config.cwd,'.wa-close-completed.json'),receipt=await fs.readFile(receiptFile,'utf8');
  await fs.writeFile(registryFile+'.new',text);await fs.rename(registryFile+'.new',registryFile);
  let stopped=false;
  assert.equal(await recoverClosedBrowser(config,{
    info:async()=>({open:!stopped,profile:config.profile,workspace:config.cwd}),stop:async()=>{stopped=true;}
  }),false);
  assert.equal(stopped,false,'A prior registration cannot authorize stopping its replacement.');
  assert.equal(await fs.readFile(receiptFile,'utf8'),receipt);
});

test('Recovery is a no-op for missing, unrelated or unregistered completion evidence',async t=>{
  const config=await isolated(t),receiptFile=path.join(config.cwd,'.wa-close-completed.json');
  const identity={registryFile:path.join(config.base,'synthetic.session'),instance:'a'.repeat(64)};
  const receipt={schemaVersion:1,browserClosed:true,session:config.session,profile:config.profile,...identity,nonce:'00000000-0000-4000-8000-000000000000'};
  const unexpected=async()=>assert.fail('Recovery must not use unrelated or incomplete evidence.');
  assert.equal(await recoverClosedBrowser(config,{info:unexpected,stop:unexpected}),false);
  await fs.mkdir(config.cwd,{recursive:true});
  for(const unrelated of [{...receipt,session:'another-session'},{...receipt,profile:path.join(config.base,'another-profile')}]){
    await fs.writeFile(receiptFile,JSON.stringify(unrelated));
    assert.equal(await recoverClosedBrowser(config,{info:unexpected,stop:unexpected}),false);
  }
  await fs.writeFile(receiptFile,JSON.stringify(receipt));
  assert.equal(await recoverClosedBrowser(config,{info:async()=>({open:true,profile:path.join(config.base,'another-profile')}),identity:unexpected,stop:unexpected}),false);
  assert.equal(await recoverClosedBrowser(config,{info:async()=>({open:true,profile:config.profile}),
    identity:async()=>{throw Object.assign(Error('Missing registration'),{code:'ENOENT'});},stop:unexpected}),false);
  assert.equal(await recoverClosedBrowser(config,{info:async()=>({open:true,profile:config.profile}),
    identity:async()=>({...identity,instance:'b'.repeat(64)}),stop:unexpected}),false);
  assert.equal(await fs.readFile(receiptFile,'utf8'),JSON.stringify(receipt));
});

test('Recovery waits for the acknowledged idle daemon to exit without issuing another stop',async t=>{
  const config=await isolated(t),receiptFile=path.join(config.cwd,'.wa-close-completed.json');
  const identity={registryFile:path.join(config.base,'synthetic.session'),instance:'a'.repeat(64)};
  const receipt={schemaVersion:1,browserClosed:true,session:config.session,profile:config.profile,...identity,nonce:'00000000-0000-4000-8000-000000000000'};
  await fs.mkdir(config.cwd,{recursive:true});await fs.writeFile(receiptFile,JSON.stringify(receipt));
  let observations=0,stops=0,sleeps=0,clock=0;
  const dependencies={info:async()=>({open:++observations<4,profile:config.profile}),identity:async()=>identity,
    stop:async()=>{stops++;},sleep:async()=>{sleeps++;clock+=100;},now:()=>clock};
  assert.equal(await recoverClosedBrowser(config,dependencies),true);
  assert.equal(stops,1);assert.equal(sleeps,2);
  await assert.rejects(fs.access(receiptFile),{code:'ENOENT'});
  await fs.writeFile(receiptFile,JSON.stringify(receipt));
  stops=0;
  await assert.rejects(recoverClosedBrowser(config,{...dependencies,info:async()=>({open:true,profile:config.profile}),
    sleep:async()=>{clock+=10000;}}),{code:'BROWSER_CLOSE_PENDING'});
  assert.equal(stops,1);
  assert.equal(await fs.readFile(receiptFile,'utf8'),JSON.stringify(receipt));
});

test('Recovery preserves a replacement receipt written while the old daemon stops',async t=>{
  const config=await isolated(t),receiptFile=path.join(config.cwd,'.wa-close-completed.json');
  const identity={registryFile:path.join(config.base,'synthetic.session'),instance:'a'.repeat(64)};
  const receipt={schemaVersion:1,browserClosed:true,session:config.session,profile:config.profile,...identity,nonce:'00000000-0000-4000-8000-000000000000'};
  const replacement={...receipt,nonce:'00000000-0000-4000-8000-000000000001'};
  await fs.mkdir(config.cwd,{recursive:true});await fs.writeFile(receiptFile,JSON.stringify(receipt));
  let stopped=false;
  assert.equal(await recoverClosedBrowser(config,{
    info:async()=>({open:!stopped,profile:config.profile}),identity:async()=>identity,
    stop:async()=>{await fs.writeFile(receiptFile,JSON.stringify(replacement));stopped=true;}
  }),true);
  assert.deepEqual(JSON.parse(await fs.readFile(receiptFile,'utf8')),replacement);
});

test('Shutdown refuses another profile and accepts a confirmed close after a disconnected reply',async t=>{
  const config=await isolated(t);let requests=0;
  const request=async()=>{requests++;throw Object.assign(Error('Session closed'),{code:'BROWSER_ERROR'});};
  await assert.rejects(closeBrowser(config,{info:async()=>({open:true,profile:'unrelated'}),request}),{code:'PROFILE_MISMATCH'});
  assert.equal(requests,0);
  const states=[{open:true,profile:config.profile},{open:false}];
  assert.deepEqual(await closeBrowser(config,{info:async()=>states.shift(),request}),{closed:true,profileRetained:true});
  assert.equal(requests,1);
});

test('An unconfirmed shutdown never reports success or falls back to a forced close',async t=>{
  const config=await isolated(t);let requests=0,clock=0;
  await assert.rejects(closeBrowser(config,{info:async()=>({open:true,profile:config.profile}),
    request:async()=>{requests++;},now:()=>clock,sleep:async()=>{clock+=10000;}}),{code:'BROWSER_CLOSE_PENDING'});
  assert.equal(requests,1);
});

test('Unknown and incompatible shutdown errors retain their original identity without a timeout delay',async t=>{
  const config=await isolated(t);
  for(const code of ['BROWSER_CLOSE_UNSUPPORTED','BROWSER_SESSION_CHANGED','EACCES']){
    const failure=Object.assign(Error('Synthetic shutdown failure'),{code,details:{preserve:true}});
    let clock=0,sleeps=0;
    await assert.rejects(closeBrowser(config,{
      info:async()=>({open:true,profile:config.profile}),request:async()=>{throw failure;},
      now:()=>clock,sleep:async()=>{clock+=10000;sleeps++;}
    }),error=>error===failure);
    assert.equal(sleeps,0);
  }
});

test('The discovered Chrome executable and visibility reach the backend without shell quoting or global settings',async t=>{
  const config=await isolated(t),chrome='/synthetic/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  for(const headed of [false,true]){
    let launched=false;
    await openBrowser(config,{headed},{check:async()=>({chrome}),run:async(c,args,_timeout,env)=>{
      launched=true;assert.equal(c.profile,config.profile);
      const file=args.find(arg=>arg.startsWith('--config=')).slice('--config='.length);
      const launch=JSON.parse(await fs.readFile(file,'utf8')).browser.launchOptions;
      assert.equal(launch.executablePath,chrome);assert.equal(launch.headless,!headed);
      assert.equal(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH,chrome);
      assert.equal(env.PLAYWRIGHT_MCP_HEADLESS,String(!headed));
      assert.ok(args.includes(`--profile=${config.profile}`));
      assert.equal(args.includes('--headed'),headed);
      return {stdout:''};
    }});
    assert.equal(launched,true);
    assert.deepEqual((await fs.readdir(config.cwd)).filter(name=>name.startsWith('.wa-browser-')),[]);
  }
});

test('Failed Chrome discovery does not launch or create configuration; timed-out launch keeps private evidence',async t=>{
  const config=await isolated(t);
  await assert.rejects(openBrowser(config,{}, {check:async()=>{throw Object.assign(Error('missing'),{code:'CHROME_MISSING'});},run:async()=>assert.fail('Must not launch')}),{code:'CHROME_MISSING'});
  await assert.rejects(fs.access(config.cwd),{code:'ENOENT'});
  await assert.rejects(openBrowser(config,{}, {check:async()=>({chrome:'/synthetic/chrome'}),run:async()=>{throw Object.assign(Error('timeout'),{code:'COMMAND_TIMEOUT'});}}),{code:'COMMAND_TIMEOUT'});
  assert.equal((await fs.readdir(config.cwd)).filter(name=>name.startsWith('.wa-browser-')).length,1);
});
