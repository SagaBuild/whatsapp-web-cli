import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {onboard,setup,linkInstructions,openLoginWindow} from '../scripts/setup.mjs';
import {dataRoot,checkRequirements} from '../scripts/platform.mjs';

function fake(states){
  const output=[],calls=[];let clock=0;
  return {output,calls,dependencies:{config:{session:'fixture',profile:'/synthetic/profile'},emit:s=>output.push(s),now:()=>clock,
    open:async()=>{calls.push('open');return states.shift();},status:async()=>{calls.push('status');return states.shift()||{authenticated:false};},sleep:async ms=>{clock+=ms;}}};
}

test('An existing login is reused without QR instructions or chat data in the result',async()=>{
  const f=fake([{authenticated:true,chat:'Do not emit this private title',messages:['private']}]);
  const r=await onboard({},f.dependencies);
  assert.equal(r.ready,true);assert.equal(r.alreadyLinked,true);assert.deepEqual(f.calls,['open']);
  assert.ok(!JSON.stringify(r).includes('private'));assert.ok(!f.output.includes(linkInstructions));
});

test('Fresh setup guides phone linking and waits for authenticated UI',async()=>{
  const f=fake([{authenticated:false,state:'login_required'},{authenticated:false},{authenticated:true}]);
  const r=await onboard({timeoutMs:5000},f.dependencies);
  assert.equal(r.ready,true);assert.equal(r.alreadyLinked,false);assert.ok(f.output.includes(linkInstructions));
  assert.deepEqual(f.calls,['open','status','status']);
});

test('A timeout retains the same profile and a later run can resume',async()=>{
  const f=fake([{authenticated:false}]);const pending=await onboard({timeoutMs:1000},f.dependencies);
  assert.equal(pending.state,'login_pending');assert.equal(pending.profile,'/synthetic/profile');
  const next=fake([{authenticated:true}]);assert.equal((await onboard({},next.dependencies)).ready,true);
  assert.ok(f.calls.every(c=>c==='open'||c==='status'));
});

test('Cancellation and busy sessions do not reset or replace the profile',async()=>{
  const abort=new AbortController();abort.abort();const f=fake([{authenticated:false}]);
  await assert.rejects(onboard({signal:abort.signal},f.dependencies),{code:'SETUP_INTERRUPTED'});
  assert.deepEqual(f.calls,['open']);
  f.dependencies.open=async()=>{throw Object.assign(Error('Busy'),{code:'BUSY'});};
  await assert.rejects(onboard({},f.dependencies),{code:'BUSY'});
});

test('Platform data directories are stable and relative overrides are rejected',()=>{
  assert.equal(dataRoot({platform:'win32',env:{LOCALAPPDATA:'C:\\Local'},home:'C:\\Example'}),'C:\\Local\\codex-whatsapp-web');
  assert.equal(dataRoot({platform:'darwin',env:{},home:'/example'}),'/example/Library/Application Support/codex-whatsapp-web');
  assert.equal(dataRoot({platform:'linux',env:{XDG_DATA_HOME:'/data'},home:'/example'}),'/data/codex-whatsapp-web');
  assert.throws(()=>dataRoot({platform:'linux',env:{WA_DATA_DIR:'relative'},home:'/example'}),{code:'DATA_DIRECTORY'});
});

test('Missing prerequisites stop setup before installing or opening a browser',async()=>{
  await assert.rejects(checkRequirements({version:'20.1.0',candidates:[],exists:async()=>true}),{code:'NODE_VERSION'});
  await assert.rejects(checkRequirements({version:'22.0.0',candidates:['missing'],exists:async()=>false}),{code:'CHROME_MISSING'});
  let installs=0;await assert.rejects(setup([],{check:async()=>{throw Object.assign(Error('No Chrome'),{code:'CHROME_MISSING'});},install:async()=>{installs++;}}),{code:'CHROME_MISSING'});
  assert.equal(installs,0);
});

test('Install-only setup does not open WhatsApp; help has no side effects',async()=>{
  let opened=0,installed=0;
  const deps={check:async()=>{},install:async()=>{installed++;return {skillDirectory:'/synthetic/skill'};},onboard:async()=>{opened++;}};
  assert.equal((await setup(['--skip-login'],deps)).state,'installed');assert.equal(installed,1);assert.equal(opened,0);
  assert.ok((await setup(['--help'],{check:async()=>assert.fail('No prerequisite check for help')})).help);
  await assert.rejects(setup(['--timeout=-1'],deps),{code:'BAD_ARGUMENT'});
});

async function loginFixture(t,authenticated){
  const scratch=fileURLToPath(new URL('../.work/setup-tests/',import.meta.url));
  await fs.mkdir(scratch,{recursive:true});
  const base=await fs.mkdtemp(path.join(scratch,'run-'));
  t.after(async()=>{assert.equal(path.dirname(base),path.resolve(scratch));await fs.rm(base,{recursive:true,force:true});});
  const config={session:'fixture',base,profile:path.join(base,'profile'),lock:path.join(base,'command.lock')};
  const calls=[];
  const backend={sessionInfo:async()=>({open:true,profile:config.profile,headed:false}),
    closeBrowser:async()=>{calls.push(['close']);},
    openBrowser:async(c,{headed})=>{calls.push(['open','https://web.whatsapp.com/','--browser=chrome',...(headed?['--headed']:[]),`--profile=${c.profile}`]);},
    runCli:async(_config,args)=>{calls.push(args);return {stdout:''};},
    act:async(_config,_fn,op)=>{assert.equal(op,'connection');return {authenticated};}};
  return {config,calls,backend};
}

test('Setup keeps an authenticated background session hidden and running',async t=>{
  const f=await loginFixture(t,true);
  const result=await openLoginWindow(f.config,f.backend);
  assert.equal(result.authenticated,true);assert.equal(result.headed,false);assert.equal(result.reused,true);
  assert.deepEqual(f.calls,[]);
});

test('Setup recovers a completed close before reusing or opening the saved profile',async t=>{
  const f=await loginFixture(t,true),order=[];
  let recovered=false;
  f.backend.recoverClosedBrowser=async config=>{assert.equal(config,f.config);order.push('recover');recovered=true;};
  f.backend.sessionInfo=async()=>{order.push('inspect');return {open:!recovered,profile:f.config.profile,headed:false};};
  const result=await openLoginWindow(f.config,f.backend);
  assert.deepEqual(order,['recover','inspect']);
  assert.equal(result.reused,false);assert.equal(result.headed,true);
  assert.deepEqual(f.calls,[['open','https://web.whatsapp.com/','--browser=chrome','--headed',`--profile=${f.config.profile}`]]);
});

test('Setup reveals an unlinked background profile for QR login, but refuses a different profile',async t=>{
  const f=await loginFixture(t,false);
  const result=await openLoginWindow(f.config,f.backend);
  assert.equal(result.authenticated,false);assert.equal(result.headed,true);
  assert.deepEqual(f.calls,[['close'],['open','https://web.whatsapp.com/','--browser=chrome','--headed',`--profile=${f.config.profile}`]]);
  f.calls.length=0;
  f.backend.sessionInfo=async()=>({open:true,profile:path.join(f.config.base,'unrelated'),headed:false});
  await assert.rejects(openLoginWindow(f.config,f.backend),{code:'PROFILE_MISMATCH'});
  assert.deepEqual(f.calls,[]);
});
