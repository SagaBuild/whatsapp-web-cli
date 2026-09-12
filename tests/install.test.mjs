import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installSkill,defaultDestination,runtimeInventory} from '../scripts/install.mjs';
import {executeNode,npmEntry,samePath} from '../scripts/platform.mjs';

const scratch=fileURLToPath(new URL('../.work/install-tests/',import.meta.url));await fs.mkdir(scratch,{recursive:true});
const root=await fs.mkdtemp(path.join(scratch,'run-'));
after(async()=>{assert.equal(path.dirname(root),path.resolve(scratch));await fs.rm(root,{recursive:true,force:true});});

async function fixture(){
  const dir=await fs.mkdtemp(path.join(root,'case-')),source=path.join(dir,'source'),destination=path.join(dir,'installed');
  await fs.mkdir(path.join(source,'scripts'),{recursive:true});
  const files=['package.json','package-lock.json','runtime-files.json','SKILL.md','scripts/wa.mjs'];
  await fs.writeFile(path.join(source,'runtime-files.json'),JSON.stringify(files));
  const dependencies={'@playwright/cli':'0.1.19',example:'1.0.0'};
  const pkg={name:'fixture',version:'0.2.0',private:true,dependencies};
  const packages={'':{name:pkg.name,version:pkg.version,dependencies},'node_modules/@playwright/cli':{version:'0.1.19'},'node_modules/example':{version:'1.0.0'}};
  await fs.writeFile(path.join(source,'package.json'),JSON.stringify(pkg));
  await fs.writeFile(path.join(source,'package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages}));
  await fs.writeFile(path.join(source,'SKILL.md'),'synthetic instructions');
  await fs.writeFile(path.join(source,'scripts/wa.mjs'),fixtureCli);
  await fs.writeFile(path.join(source,'STATE.md'),'PRIVATE SYNTHETIC STATE');
  await writePackages(source,packages);
  const account=path.join(dir,'account'),profile=path.join(account,'profile');
  const env={...process.env,WA_DATA_DIR:account,NO_UPDATE_NOTIFIER:'1'};
  delete env.WA_PLAYWRIGHT_CLI;
  const calls=[],executions=[],deps={npm:async()=>'/synthetic/npm-cli.js',execute:async(args,options)=>{
    const {cwd}=options;
    calls.push(args);
    executions.push({args,options});
    assert.ok(await samePath(cwd,source)||await samePath(cwd,destination),'Unknown fixture cwd');
    if(args[0]==='/synthetic/npm-cli.js'){
      assert.deepEqual(args,['/synthetic/npm-cli.js','ci','--ignore-scripts','--no-audit','--no-fund']);
      const lock=JSON.parse(await fs.readFile(path.join(cwd,'package-lock.json'),'utf8'));
      const pkg=JSON.parse(await fs.readFile(path.join(cwd,'package.json'),'utf8'));
      assert.equal(lock.lockfileVersion,3);
      assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);
      for(const [name,version] of Object.entries(pkg.dependencies))assert.equal(lock.packages[`node_modules/${name}`].version,version);
      await writePackages(cwd,lock.packages);return {stdout:'synthetic npm install',stderr:''};
    }
    assert.equal(args.length,2);
    if(path.basename(args[0])==='playwright-cli.js')assert.equal(args[1],'--version');
    else{assert.equal(path.basename(args[0]),'wa.mjs');assert.ok(['close','doctor'].includes(args[1]));}
    return executeNode(args,{...options,env:{...env,...options.env,WA_DATA_DIR:account,NO_UPDATE_NOTIFIER:'1'}});
  }};
  return {dir,source,destination,calls,executions,deps,account,profile,env};
}

// The child uses production settings to bind every profile observation to the
// explicit synthetic WA_DATA_DIR, without starting a browser or account session.
const fixtureCli=`import fs from 'node:fs/promises';
import path from 'node:path';
import {settings} from ${JSON.stringify(new URL('../scripts/transport.mjs',import.meta.url).href)};
const config=settings();
if(process.argv[2]==='close'){
  await fs.mkdir(config.base,{recursive:true});
  await fs.writeFile(path.join(config.base,'close-observed.json'),JSON.stringify(config));
}else if(process.argv[2]!=='doctor')throw Error('Unexpected synthetic command');
console.log(JSON.stringify({ok:true,profile:config.profile}));`;

async function writePackages(directory,packages){
  for(const [name,pkg] of Object.entries(packages).filter(([name])=>name)){
    await fs.mkdir(path.join(directory,name),{recursive:true});
    await fs.writeFile(path.join(directory,name,'package.json'),JSON.stringify({name:name.slice('node_modules/'.length),version:pkg.version}));
  }
  const cli=path.join(directory,'node_modules/@playwright/cli');
  await fs.writeFile(path.join(cli,'playwright-cli.js'),"require('./runtime.cjs');\n");
  await fs.writeFile(path.join(cli,'runtime.cjs'),"require('example'); if(process.argv[2]!=='--version')throw Error('Unexpected CLI command'); console.log(require('./package.json').version);\n");
  await fs.writeFile(path.join(directory,'node_modules/example/index.js'),'module.exports="synthetic runtime";\n');
  await fs.writeFile(path.join(directory,'node_modules/.package-lock.json'),JSON.stringify({lockfileVersion:3,packages:Object.fromEntries(Object.entries(packages).filter(([name])=>name))}));
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
  const profile=f.profile;await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,'sentinel'),'keep login');
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
  await fs.mkdir(f.profile,{recursive:true});await fs.writeFile(path.join(f.profile,'sentinel'),'keep linked profile');
  await requireNewDependency(f);await installSkill(f,f.deps);
  const changes=f.calls.filter(args=>args.at(-1)==='close'||args.includes('ci'));
  assert.equal(changes[0].at(-1),'close');assert.equal(changes[1][1],'ci');
  const observed=JSON.parse(await fs.readFile(path.join(f.account,'close-observed.json'),'utf8'));
  assert.equal(observed.profile,f.profile);
  assert.equal(await fs.readFile(path.join(observed.profile,'sentinel'),'utf8'),'keep linked profile');
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
  lock.packages[''].dependencies.example='2.0.0';
  const pkg=JSON.parse(await fs.readFile(path.join(f.source,'package.json'),'utf8'));pkg.dependencies.example='2.0.0';
  await fs.writeFile(path.join(f.source,'package.json'),JSON.stringify(pkg));
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
    if(!await samePath(source,skill))return copyFile(source,target,flags);
    await fs.writeFile(target,'synthetic partial copy');
    throw Object.assign(Error('Synthetic full disk'),{code:'ENOSPC'});
  });
  await assert.rejects(installSkill(f,f.deps),{code:'ENOSPC'});
  assert.equal(await fs.readFile(path.join(f.destination,'SKILL.md'),'utf8'),'synthetic instructions');
  assert.ok(!(await fs.readdir(f.destination)).some(file=>file.startsWith('.wa-install-')));
});

test('A damaged dependency implementation is repaired through a healthy source backend',async()=>{
  const f=await fixture();await installSkill(f,f.deps);
  await fs.mkdir(f.profile,{recursive:true});await fs.writeFile(path.join(f.profile,'sentinel'),'preserve login');
  await fs.unlink(path.join(f.destination,'node_modules/example/index.js'));f.calls.length=0;
  const result=await installSkill(f,f.deps);
  assert.equal(result.dependenciesInstalled,true);assert.ok(f.calls.some(args=>args.includes('ci')));
  const close=f.calls.find(args=>args.at(-1)==='close');
  assert.ok(await samePath(close[0],path.join(f.source,'scripts/wa.mjs')));
  const closeExecution=f.executions.find(call=>call.args===close);
  assert.ok(await samePath(closeExecution.options.env.WA_PLAYWRIGHT_CLI,path.join(f.source,'node_modules/@playwright/cli/playwright-cli.js')));
  const observed=JSON.parse(await fs.readFile(path.join(f.account,'close-observed.json'),'utf8'));
  assert.equal(observed.profile,f.profile);assert.equal(await fs.readFile(path.join(f.profile,'sentinel'),'utf8'),'preserve login');
  assert.equal((await executeNode([path.join(f.destination,'node_modules/@playwright/cli/playwright-cli.js'),'--version'],{env:f.env})).stdout.trim(),'0.1.19');
});

test('Two direct aliases of one installation cannot enter dependency replacement concurrently',async()=>{
  const f=await fixture(),alias=path.join(f.dir,'source-alias');
  await fs.symlink(f.source,alias,process.platform==='win32'?'junction':'dir');
  await fs.unlink(path.join(f.source,'node_modules/.package-lock.json'));
  let entered,release;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const execute=f.deps.execute;let calls=0;
  f.deps.execute=async(args,options)=>{
    if(args.includes('ci')&&++calls===1){entered();await gate;}
    return execute(args,options);
  };
  const first=installSkill({...f,destination:f.source},f.deps);
  await Promise.race([started,first.then(()=>assert.fail('First install must enter npm'))]);
  try{await assert.rejects(installSkill({...f,destination:alias},f.deps),{code:'BUSY'});}
  finally{release();await first;}
  assert.equal(calls,1);
});

test('Managed destination directory links are refused before changing outside files',async()=>{
  const f=await fixture();await installSkill(f,f.deps);
  const outside=path.join(f.dir,'outside');await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'wa.mjs'),'outside sentinel');
  await fs.unlink(path.join(f.destination,'scripts/wa.mjs'));await fs.rmdir(path.join(f.destination,'scripts'));
  await fs.symlink(outside,path.join(f.destination,'scripts'),process.platform==='win32'?'junction':'dir');
  f.calls.length=0;
  await assert.rejects(installSkill(f,f.deps),{code:'INSTALL_DESTINATION'});
  assert.equal(await fs.readFile(path.join(outside,'wa.mjs'),'utf8'),'outside sentinel');
  assert.equal(f.calls.length,0);
});

test('An integrity-only dependency lock change triggers installation',async()=>{
  const f=await fixture();await installSkill(f,f.deps);f.calls.length=0;
  const lock=JSON.parse(await fs.readFile(path.join(f.source,'package-lock.json'),'utf8'));
  lock.packages['node_modules/example'].integrity='sha512-'+Buffer.alloc(64,1).toString('base64');
  await fs.writeFile(path.join(f.source,'package-lock.json'),JSON.stringify(lock));
  assert.equal((await installSkill(f,f.deps)).dependenciesInstalled,true);
  assert.ok(f.calls.some(args=>args.includes('ci')));
});

test('A zero-exit npm command that installs nothing cannot receive a successful receipt',async()=>{
  const f=await fixture(),execute=f.deps.execute;
  f.deps.execute=async(args,options)=>args.includes('ci')?{stdout:'synthetic dry run',stderr:''}:execute(args,options);
  await assert.rejects(installSkill(f,f.deps),{code:'INSTALL_DEPENDENCIES'});
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination,'.whatsapp-web-managed'),'utf8')).dependencyFingerprint,null);
});

test('A working CLI cannot conceal a wrong transitive version after npm reports success',async()=>{
  const f=await fixture(),execute=f.deps.execute;
  f.deps.execute=async(args,options)=>{
    const result=await execute(args,options);
    if(args.includes('ci'))await fs.writeFile(path.join(options.cwd,'node_modules/example/package.json'),JSON.stringify({name:'example',version:'9.0.0'}));
    return result;
  };
  await assert.rejects(installSkill(f,f.deps),{code:'INSTALL_DEPENDENCIES'});
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination,'.whatsapp-web-managed'),'utf8')).dependencyFingerprint,null);
});

test('An unusable source fallback cannot replace dependencies or reset an unconfirmed browser',async()=>{
  const f=await fixture();await installSkill(f,f.deps);
  const marker=path.join(f.destination,'.whatsapp-web-managed'),before=await fs.readFile(marker,'utf8');
  for(const directory of [f.source,f.destination])await fs.unlink(path.join(directory,'node_modules/example/index.js'));
  f.calls.length=0;
  await assert.rejects(installSkill(f,f.deps),{code:'CLI_UNHEALTHY'});
  assert.ok(!f.calls.some(args=>args.includes('ci')||args.at(-1)==='close'));
  assert.equal(await fs.readFile(marker,'utf8'),before);
});

test('Real offline npm installs a local package, suppresses lifecycle scripts and repairs its damaged runtime',async()=>{
  const f=await fixture(),npm=await npmEntry();
  const packageDirectory=path.join(f.dir,'local-package');await fs.mkdir(packageDirectory);
  const localPackage={name:'@playwright/cli',version:'0.1.19',bin:{'playwright-cli':'playwright-cli.js'},
    scripts:{install:'node -e "require(\'node:fs\').writeFileSync(\'UNEXPECTED_INSTALL_SCRIPT\',\'ran\')"'}};
  await fs.writeFile(path.join(packageDirectory,'package.json'),JSON.stringify(localPackage));
  await fs.writeFile(path.join(packageDirectory,'playwright-cli.js'),"#!/usr/bin/env node\nrequire('./runtime.cjs');\n");
  await fs.writeFile(path.join(packageDirectory,'runtime.cjs'),"if(process.argv[2]!=='--version')throw Error('Unexpected CLI command'); console.log(require('./package.json').version);\n");
  const env={...f.env,npm_config_offline:'true',npm_config_cache:path.join(f.dir,'npm-cache'),npm_config_userconfig:path.join(f.dir,'absent-npmrc'),npm_config_update_notifier:'false'};
  const run=(args,cwd)=>executeNode(args,{cwd,env,timeout:30000});
  const packed=JSON.parse((await run([npm,'pack','--ignore-scripts','--json','--pack-destination',f.dir],packageDirectory)).stdout);
  const tarball=path.join(f.dir,packed[0].filename);
  const pkg={name:'offline-installer-fixture',version:'0.2.0',private:true,dependencies:{'@playwright/cli':'file:'+tarball.split(path.sep).join('/')}};
  await fs.writeFile(path.join(f.source,'package.json'),JSON.stringify(pkg));
  await fs.unlink(path.join(f.source,'package-lock.json'));
  await run([npm,'install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],f.source);
  // Bootstrap only this synthetic source, giving repairs a healthy close backend.
  await run([npm,'ci','--ignore-scripts','--no-audit','--no-fund'],f.source);
  const calls=[],dependencies={npm:async()=>npm,execute:async(args,options)=>{
    calls.push({args,options});
    if(args[0]===npm)assert.deepEqual(args,[npm,'ci','--ignore-scripts','--no-audit','--no-fund']);
    return executeNode(args,{...options,env:{...env,...options.env,WA_DATA_DIR:f.account,npm_config_offline:'true',npm_config_cache:env.npm_config_cache,npm_config_userconfig:env.npm_config_userconfig,NO_UPDATE_NOTIFIER:'1'}});
  }};
  assert.equal((await installSkill(f,dependencies)).dependenciesInstalled,true);
  const cliDirectory=path.join(f.destination,'node_modules/@playwright/cli');
  await assert.rejects(fs.access(path.join(cliDirectory,'UNEXPECTED_INSTALL_SCRIPT')),{code:'ENOENT'});
  assert.equal((await run([path.join(cliDirectory,'playwright-cli.js'),'--version'],f.destination)).stdout.trim(),'0.1.19');
  await fs.mkdir(f.profile,{recursive:true});await fs.writeFile(path.join(f.profile,'sentinel'),'offline linked profile');
  await fs.unlink(path.join(cliDirectory,'runtime.cjs'));calls.length=0;
  assert.equal((await installSkill(f,dependencies)).dependenciesInstalled,true);
  const close=calls.find(call=>call.args.at(-1)==='close'),ci=calls.findIndex(call=>call.args[0]===npm);
  assert.ok(await samePath(close.args[0],path.join(f.source,'scripts/wa.mjs')));assert.ok(calls.indexOf(close)<ci);
  assert.equal((await run([path.join(cliDirectory,'playwright-cli.js'),'--version'],f.destination)).stdout.trim(),'0.1.19');
  assert.equal(await fs.readFile(path.join(f.profile,'sentinel'),'utf8'),'offline linked profile');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.account,'close-observed.json'),'utf8')).profile,f.profile);
  await assert.rejects(fs.access(path.join(cliDirectory,'UNEXPECTED_INSTALL_SCRIPT')),{code:'ENOENT'});
});
