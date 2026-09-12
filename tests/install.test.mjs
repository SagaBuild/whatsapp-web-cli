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
    if(args.includes('ci')){
      const cli=path.join(cwd,'node_modules/@playwright/cli/playwright-cli.js');await fs.mkdir(path.dirname(cli),{recursive:true});await fs.writeFile(cli,'// dependency');
      const lock=JSON.parse(await fs.readFile(path.join(cwd,'package-lock.json'),'utf8'));
      const packages=Object.fromEntries(Object.entries(lock.packages).filter(([name])=>name));
      for(const [name,pkg] of Object.entries(packages)){
        await fs.mkdir(path.join(cwd,name),{recursive:true});
        await fs.writeFile(path.join(cwd,name,'package.json'),JSON.stringify({version:pkg.version}));
      }
      await fs.writeFile(path.join(cwd,'node_modules/.package-lock.json'),JSON.stringify({packages}));
    }
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

async function requireNewDependency(f){
  const lock=JSON.parse(await fs.readFile(path.join(f.source,'package-lock.json'),'utf8'));
  lock.packages['node_modules/example'].version='2.0.0';
  await fs.writeFile(path.join(f.source,'package-lock.json'),JSON.stringify(lock));
  return lock;
}

test('A failed dependency update is repaired on retry despite the copied desired lockfile',async()=>{
  const f=await fixture();await installSkill(f,f.deps);await requireNewDependency(f);
  const execute=f.deps.execute;
  f.deps.execute=async(args,options)=>{
    if(args.includes('ci'))throw Object.assign(Error('Synthetic npm failure before replacement'),{code:'PROCESS_FAILED'});
    return execute(args,options);
  };
  await assert.rejects(installSkill(f,f.deps),{code:'PROCESS_FAILED'});
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination,'package-lock.json'),'utf8')).packages['node_modules/example'].version,'2.0.0');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination,'node_modules/example/package.json'),'utf8')).version,'1.0.0');
  f.deps.execute=execute;f.calls.length=0;
  const retry=await installSkill(f,f.deps);
  assert.equal(retry.dependenciesInstalled,true);
  assert.ok(f.calls.some(args=>args.includes('ci')));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination,'node_modules/example/package.json'),'utf8')).version,'2.0.0');
  f.calls.length=0;
  assert.equal((await installSkill(f,f.deps)).dependenciesInstalled,false);
  assert.ok(!f.calls.some(args=>args.includes('ci')||args.includes('close')));
});

test('A missing npm command does not turn a dependency update into a successful code-only retry',async()=>{
  const f=await fixture();await installSkill(f,f.deps);await requireNewDependency(f);
  const npm=f.deps.npm;f.deps.npm=async()=>{throw Object.assign(Error('Synthetic missing npm'),{code:'NPM_MISSING'});};
  await assert.rejects(installSkill(f,f.deps),{code:'NPM_MISSING'});
  f.deps.npm=npm;f.calls.length=0;
  assert.equal((await installSkill(f,f.deps)).dependenciesInstalled,true);
  assert.ok(f.calls.some(args=>args.includes('ci')));
});

test('Legacy managed installations use the installed npm tree and do not reset unchanged dependencies',async()=>{
  const f=await fixture();await installSkill(f,f.deps);
  await fs.writeFile(path.join(f.destination,'.whatsapp-web-managed'),'0.3.0\n');
  const pkg=JSON.parse(await fs.readFile(path.join(f.source,'package.json'),'utf8'));pkg.version='0.3.1';
  await fs.writeFile(path.join(f.source,'package.json'),JSON.stringify(pkg));f.calls.length=0;
  const result=await installSkill(f,f.deps);
  assert.equal(result.version,'0.3.1');assert.equal(result.dependenciesInstalled,false);
  assert.ok(!f.calls.some(args=>args.includes('ci')||args.includes('close')));
});

test('A legacy failed update is detected even when its destination lockfile already matches source',async()=>{
  const f=await fixture();await installSkill(f,f.deps);const lock=await requireNewDependency(f);
  await fs.writeFile(path.join(f.destination,'.whatsapp-web-managed'),'0.3.0\n');
  await fs.writeFile(path.join(f.destination,'package-lock.json'),JSON.stringify(lock));f.calls.length=0;
  assert.equal((await installSkill(f,f.deps)).dependenciesInstalled,true);
  assert.ok(f.calls.some(args=>args.includes('ci')));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination,'node_modules/example/package.json'),'utf8')).version,'2.0.0');
});

test('Successful dependency installation is retained when the later doctor check fails',async()=>{
  const f=await fixture();await installSkill(f,f.deps);await requireNewDependency(f);
  const execute=f.deps.execute;
  f.deps.execute=async(args,options)=>{
    if(args.at(-1)==='doctor')throw Object.assign(Error('Synthetic missing Chrome after npm succeeded'),{code:'PROCESS_FAILED'});
    return execute(args,options);
  };
  await assert.rejects(installSkill(f,f.deps),{code:'PROCESS_FAILED'});
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination,'node_modules/example/package.json'),'utf8')).version,'2.0.0');
  f.deps.execute=execute;f.calls.length=0;
  assert.equal((await installSkill(f,f.deps)).dependenciesInstalled,false);
  assert.ok(!f.calls.some(args=>args.includes('ci')||args.includes('close')));
});

test('Installed metadata does not hide a missing dependency package',async()=>{
  const f=await fixture();await installSkill(f,f.deps);
  await fs.unlink(path.join(f.destination,'node_modules/example/package.json'));f.calls.length=0;
  assert.equal((await installSkill(f,f.deps)).dependenciesInstalled,true);
  assert.ok(f.calls.some(args=>args.includes('ci')));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination,'node_modules/example/package.json'),'utf8')).version,'1.0.0');
});

test('Atomic replacement keeps hardlinked marker and code contents outside the destination unchanged',async()=>{
  const f=await fixture();await installSkill(f,f.deps);
  for(const entry of ['.whatsapp-web-managed','scripts/wa.mjs']){
    const target=path.join(f.destination,entry),outside=path.join(f.dir,path.basename(entry)+'.outside');
    await fs.writeFile(outside,'synthetic outside content');await fs.unlink(target);await fs.link(outside,target);
  }
  await fs.writeFile(path.join(f.source,'scripts/wa.mjs'),'// updated fixture');
  await installSkill(f,f.deps);
  for(const entry of ['.whatsapp-web-managed','scripts/wa.mjs'])assert.equal(await fs.readFile(path.join(f.dir,path.basename(entry)+'.outside'),'utf8'),'synthetic outside content');
  assert.equal(await fs.readFile(path.join(f.destination,'scripts/wa.mjs'),'utf8'),'// updated fixture');
});

test('A failed staged file copy preserves the existing installed file and removes its temporary',async t=>{
  const f=await fixture();await installSkill(f,f.deps);
  const copyFile=fs.copyFile.bind(fs),skill=path.join(f.source,'SKILL.md');
  t.mock.method(fs,'copyFile',async(source,target,flags)=>{
    if(source!==skill)return copyFile(source,target,flags);
    await fs.writeFile(target,'synthetic partial copy');
    throw Object.assign(Error('Synthetic full disk'),{code:'ENOSPC'});
  });
  await assert.rejects(installSkill(f,f.deps),{code:'ENOSPC'});
  assert.equal(await fs.readFile(path.join(f.destination,'SKILL.md'),'utf8'),'synthetic instructions');
  assert.ok(!(await fs.readdir(f.destination)).some(file=>file.startsWith('.wa-install-')));
});
