import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {settings,findCli,runCli,parseResult,act,sessionInfo,openBrowser,closeBrowser,recoverClosedBrowser} from '../scripts/transport.mjs';

const scratch=fileURLToPath(new URL('../.work/transport-tests/',import.meta.url));
await fs.mkdir(scratch,{recursive:true});
const root=await fs.mkdtemp(path.join(scratch,'run-'));
after(async()=>{assert.equal(path.dirname(root),path.resolve(scratch));await fs.rm(root,{recursive:true,force:true});});
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

test('The actual pinned CLI launches the detected Chrome and reopens only its isolated persistent profile',async t=>{
  const config=await isolated(t);
  process.env.WA_PLAYWRIGHT_CLI=require.resolve('@playwright/cli/playwright-cli.js');
  const open=()=>openBrowser(config,{url:'about:blank'});
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
  try {
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
  } finally {
    // Close while fixture registry overrides are still active; test.after restores them.
    await closeBrowser(config);
    assert.equal((await sessionInfo(config)).open,false);
  }
});

test('A lost completed shutdown reply recovers the idle daemon and preserves its persistent cookie',async t=>{
  const config=await isolated(t),fault=await lostCloseResponseBackend(config);
  try{
    await openBrowser(config,{url:'about:blank'});
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
    const cookies=await act(config,async page=>page.context().cookies('https://transport.fixture.test'),'fixture');
    assert.equal(cookies.find(cookie=>cookie.name==='lost-reply')?.value,'synthetic-persistent-cookie');
  }finally{
    await fs.rm(fault.flag,{force:true});
    await closeBrowser(config);
    assert.equal((await sessionInfo(config)).open,false);
  }
});

test('Interrupted shutdown recovery needs no page and an old receipt cannot stop a new daemon for the same profile',async t=>{
  const config=await isolated(t),fault=await lostCloseResponseBackend(config);
  const receiptFile=path.join(config.cwd,'.wa-close-completed.json');
  try{
    await openBrowser(config,{url:'about:blank'});
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
    await fs.writeFile(receiptFile,receipt);
    assert.equal(await recoverClosedBrowser(config),false,'A new registration invalidates completion evidence from the previous daemon.');
    assert.equal(await fs.readFile(receiptFile,'utf8'),receipt);
    assert.equal((await sessionInfo(config)).open,true);
    assert.equal(await act(config,async page=>page.url(),'fixture'),'about:blank');
  }finally{
    await fs.rm(fault.flag,{force:true});
    await closeBrowser(config);
    assert.equal((await sessionInfo(config)).open,false);
  }
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
