import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';

const require=createRequire(import.meta.url);
const backend=require.resolve('@playwright/cli/playwright-cli.js');

function descendant(parent,file){
  const relative=path.relative(path.resolve(parent),path.resolve(file));
  return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
}

// Test-only cleanup. Never use the transport functions under test to clean up
// their own broken browser, and never target a profile outside this test's root.
export function createBrowserFixture(config,{root}){
  assert.ok(path.isAbsolute(root));
  const env={...process.env,WA_DATA_DIR:config.root,NO_UPDATE_NOTIFIER:'1'};
  const scoped=[config.cwd,config.profile,env.PWTEST_DAEMON_SESSION_DIR,env.PWTEST_SERVER_REGISTRY];
  for(const file of scoped)assert.ok(typeof file==='string'&&descendant(root,file),'Synthetic browser paths must stay inside the explicit test root.');
  let processes=[],cleaned=false;

  async function command(args){
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[backend,`-s=${config.session}`,...args],{cwd:config.cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',text=>stdout+=text);child.stderr.on('data',text=>stderr+=text);
      const timer=setTimeout(()=>{child.kill();reject(Error('Synthetic backend cleanup command timed out; retain its private registry.'));},15000);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{
        clearTimeout(timer);
        if(code!==0||/^### Error/m.test(stdout))reject(Error(`Synthetic backend cleanup failed: ${stderr||stdout||code}`));
        else resolve(stdout);
      });
    });
  }

  async function info(){
    const data=JSON.parse(await command(['list','--json']));
    assert.ok(Array.isArray(data.browsers));
    const matching=data.browsers.filter(browser=>browser.name===config.session);
    assert.ok(matching.length<=1,'Do not clean up an ambiguous synthetic session.');
    const current=matching[0];
    if(current?.status==='open'){
      assert.equal(await fs.realpath(current.userDataDir),await fs.realpath(config.profile),'Do not close a browser using another profile.');
      assert.equal(await fs.realpath(current.workspace),await fs.realpath(config.cwd));
    }
    return current;
  }

  async function record(){
    assert.equal((await info())?.status,'open');
    const code=`async page=>{
      const host=page.context().constructor.constructor('return process')();
      const browser=host._getActiveHandles().filter(handle=>Array.isArray(handle.spawnargs)&&handle.spawnargs.includes(${JSON.stringify('--user-data-dir='+config.profile)}));
      return {daemon:host.pid,browsers:browser.map(handle=>handle.pid)};
    }`;
    const stdout=await command(['run-code',code]);
    const match=stdout.match(/### Result\r?\n([\s\S]*?)(?:\r?\n### |$)/);
    assert.ok(match,'The synthetic daemon must report its owned process identities.');
    const identity=JSON.parse(match[1]);
    assert.ok(Number.isSafeInteger(identity.daemon)&&identity.daemon>1);
    assert.ok(Array.isArray(identity.browsers)&&identity.browsers.length>0,'Record the exact launched synthetic Chrome process.');
    processes=[identity.daemon,...identity.browsers];
    assert.ok(processes.every(pid=>Number.isSafeInteger(pid)&&pid>1));
    cleaned=false;
    await fs.writeFile(path.join(config.cwd,'.fixture-processes.json'),JSON.stringify({profile:config.profile,processes}),{mode:0o600});
  }

  async function cleanup(){
    if(cleaned)return;
    try{await fs.access(config.cwd);}catch(error){
      if(error.code!=='ENOENT')throw error;
      assert.equal(processes.length,0,'Do not discard the registry of a recorded browser.');
      cleaned=true;return;
    }
    const canonicalRoot=await fs.realpath(root);
    for(const file of [config.cwd,config.profile]){
      try{assert.ok(descendant(canonicalRoot,await fs.realpath(file)));}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    if((await info())?.status==='open'){
      // Capture after a failed open reply too, if no successful open was recorded.
      if(!processes.length)await record();
      await command(['close']);
    }
    const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
    const deadline=Date.now()+15000;
    while(processes.some(alive)){
      assert.ok(Date.now()<deadline,'Synthetic browser/daemon has not exited; retain the profile and registry.');
      await delay(50);
    }
    assert.notEqual((await info())?.status,'open');
    cleaned=true;
  }

  return {record,cleanup,get cleaned(){return cleaned;},get processes(){return [...processes];}};
}
