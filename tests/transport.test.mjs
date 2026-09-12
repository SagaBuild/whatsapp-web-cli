import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {settings,findCli,runCli,parseResult,act,sessionInfo,openBrowser} from '../scripts/transport.mjs';

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
    await runCli(config,['close']);
    assert.equal((await sessionInfo(config)).open,false);
    await open();
    assert.equal((await sessionInfo(config)).profile,config.profile);
    assert.equal((await sessionInfo(config)).headed,false);
    const cookies=await act(config,async page=>page.context().cookies('https://transport.fixture.test'),'fixture');
    assert.equal(cookies.find(cookie=>cookie.name==='fixture')?.value,cookieValue);
  } finally {
    // Close while fixture registry overrides are still active; test.after restores them.
    await runCli(config,['close']);
    assert.equal((await sessionInfo(config)).open,false);
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
