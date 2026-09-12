import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installSkill,defaultDestination,runtimeInventory} from '../scripts/install.mjs';

const scratch=fileURLToPath(new URL('../.work/install-tests/',import.meta.url));await fs.mkdir(scratch,{recursive:true});
const root=await fs.mkdtemp(path.join(scratch,'run-'));
after(async()=>{assert.equal(path.dirname(root),path.resolve(scratch));await fs.rm(root,{recursive:true,force:true});});

async function fixture(){
  const dir=await fs.mkdtemp(path.join(root,'case-')),source=path.join(dir,'source'),destination=path.join(dir,'installed');
  await fs.mkdir(path.join(source,'scripts'),{recursive:true});
  const files=['package.json','package-lock.json','runtime-files.json','SKILL.md','scripts/wa.mjs'];
  await fs.writeFile(path.join(source,'runtime-files.json'),JSON.stringify(files));
  await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'fixture',version:'0.2.0'}));
  await fs.writeFile(path.join(source,'package-lock.json'),JSON.stringify({packages:{'':{version:'0.2.0'},'node_modules/example':{version:'1.0.0'}}}));
  await fs.writeFile(path.join(source,'SKILL.md'),'synthetic instructions');await fs.writeFile(path.join(source,'scripts/wa.mjs'),'// fixture');
  await fs.writeFile(path.join(source,'STATE.md'),'PRIVATE SYNTHETIC STATE');
  const calls=[],deps={npm:async()=>'/synthetic/npm-cli.js',execute:async(args,{cwd})=>{
    calls.push(args);
    if(args.includes('ci')){const cli=path.join(cwd,'node_modules/@playwright/cli/playwright-cli.js');await fs.mkdir(path.dirname(cli),{recursive:true});await fs.writeFile(cli,'// dependency');}
    return {stdout:'{}'};
  }};
  return {dir,source,destination,calls,deps};
}

test('Installation copies only the runtime inventory and keeps synthetic account data outside it',async()=>{
  const f=await fixture();const result=await installSkill(f,f.deps);
  assert.equal(result.version,'0.2.0');assert.equal(result.dependenciesInstalled,true);
  await assert.rejects(fs.access(path.join(f.destination,'STATE.md')),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(f.destination,'SKILL.md'),'utf8'),'synthetic instructions');
  assert.ok(f.calls.some(a=>a.includes('--ignore-scripts')));
});

test('Repeated code installation retains existing dependencies and login data',async()=>{
  const f=await fixture();await installSkill(f,f.deps);f.calls.length=0;
  const profile=path.join(f.dir,'private-profile');await fs.mkdir(profile);await fs.writeFile(path.join(profile,'sentinel'),'keep login');
  const result=await installSkill(f,f.deps);
  assert.equal(result.dependenciesInstalled,false);assert.ok(!f.calls.some(a=>a.includes('close')||a.includes('ci')));
  assert.equal(await fs.readFile(path.join(profile,'sentinel'),'utf8'),'keep login');
});

test('Unknown destinations and escaping inventories are rejected without overwriting files',async()=>{
  const f=await fixture();await fs.mkdir(f.destination);await fs.writeFile(path.join(f.destination,'keep'),'existing');
  await assert.rejects(installSkill(f,f.deps),{code:'UNMANAGED_INSTALL'});
  assert.equal(await fs.readFile(path.join(f.destination,'keep'),'utf8'),'existing');
  await fs.writeFile(path.join(f.source,'runtime-files.json'),JSON.stringify(['../private.txt']));
  await assert.rejects(runtimeInventory(f.source),{code:'INSTALL_SOURCE'});
});

test('A dependency update closes the managed browser before npm without touching its profile',async()=>{
  const f=await fixture();await installSkill(f,f.deps);f.calls.length=0;
  const lock=JSON.parse(await fs.readFile(path.join(f.source,'package-lock.json'),'utf8'));lock.packages['node_modules/example'].version='2.0.0';
  await fs.writeFile(path.join(f.source,'package-lock.json'),JSON.stringify(lock));await installSkill(f,f.deps);
  assert.equal(f.calls[0].at(-1),'close');assert.equal(f.calls[1][1],'ci');
});

test('Existing managed legacy installations are reused; fresh installs use documented user scope',async()=>{
  const f=await fixture(),home=path.join(f.dir,'home');await fs.mkdir(home);
  const legacy=path.join(home,'.codex/skills/whatsapp-web');
  assert.equal(await defaultDestination({home,env:{}}),path.join(home,'.agents/skills/whatsapp-web'));
  await fs.mkdir(legacy,{recursive:true});await fs.writeFile(path.join(legacy,'.whatsapp-web-managed'),'0.1.1');
  assert.equal(await defaultDestination({home,env:{}}),legacy);
});

test('Current and legacy aliases of one installed skill do not count as two installations',async()=>{
  const f=await fixture(),home=path.join(f.dir,'home'),agents=path.join(home,'.agents');
  const current=path.join(agents,'skills','whatsapp-web');
  await fs.mkdir(current,{recursive:true});await fs.writeFile(path.join(current,'.whatsapp-web-managed'),'fixture');
  assert.equal(await defaultDestination({home,env:{CODEX_HOME:agents}}),current);
  await fs.symlink(agents,path.join(home,'.codex'),process.platform==='win32'?'junction':'dir');
  assert.equal(await defaultDestination({home,env:{}}),current);
});
