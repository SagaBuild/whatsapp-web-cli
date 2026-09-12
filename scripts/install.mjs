#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {fail,withLock} from './storage.mjs';
import {executeNode,npmEntry,samePath,isMain,checkCliHealth} from './platform.mjs';

const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const marker='.whatsapp-web-managed';
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};

async function readJson(file){
  try{return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
}

function dependencyPackages(lock){
  if(!lock?.packages||typeof lock.packages!=='object'||Array.isArray(lock.packages))return null;
  return Object.fromEntries(Object.entries(lock.packages).filter(([name])=>name));
}

function dependencyFingerprint(packages){
  if(!packages)return null;
  const canonical=value=>Array.isArray(value)?value.map(canonical)
    :value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  return createHash('sha256').update(JSON.stringify(canonical(packages))).digest('hex');
}

async function installedVersionsMatch(destination,packages){
  for(const [directory,expected] of Object.entries(packages)){
    const installed=await readJson(path.join(destination,directory,'package.json'));
    if(!installed||installed.version!==expected.version)return false;
  }
  return true;
}

async function canonicalDestination(destination){
  // Existing aliases must share one lock; for a fresh destination resolve its
  // nearest existing parent before adding the missing path components.
  try{return await fs.realpath(destination);}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    const parent=path.dirname(destination);
    if(parent===destination)throw error;
    return path.join(await canonicalDestination(parent),path.basename(destination));
  }
}

async function validateDestinationFile(destination,target,{same=false}={}){
  let cursor=target;
  while(cursor!==path.dirname(destination)){
    try{
      const stat=await fs.lstat(cursor);
      if(stat.isSymbolicLink()&&!(same&&cursor===destination))throw fail('INSTALL_DESTINATION','Destination files/directories cannot be symbolic links.');
      if(cursor===target&&!stat.isFile())throw fail('INSTALL_DESTINATION','Managed destination files must be regular files.');
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(cursor===destination)break;cursor=path.dirname(cursor);
  }
}

async function replaceFile(target,write){
  await fs.mkdir(path.dirname(target),{recursive:true});
  const temporary=path.join(path.dirname(target),`.wa-install-${randomUUID()}.tmp`);
  try{await write(temporary);await fs.rename(temporary,target);}
  finally{await fs.rm(temporary,{force:true});}
}

const writeMarker=(file,state)=>replaceFile(file,temporary=>fs.writeFile(temporary,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600}));

export async function defaultDestination({env=process.env,home=os.homedir()}={}) {
  const current=path.join(home,'.agents','skills','whatsapp-web');
  const legacy=path.join(env.CODEX_HOME||path.join(home,'.codex'),'skills','whatsapp-web');
  const managed=[];
  for(const directory of [current,legacy])if(await exists(path.join(directory,marker))){
    if(!(await Promise.all(managed.map(other=>samePath(directory,other)))).some(Boolean))managed.push(directory);
  }
  if(managed.length>1)throw fail('MULTIPLE_INSTALLATIONS','More than one managed skill exists. Choose one with --destination to avoid duplicate skill discovery.');
  return managed[0]||(env.CODEX_HOME?legacy:current);
}

export async function runtimeInventory(source) {
  const entries=JSON.parse(await fs.readFile(path.join(source,'runtime-files.json'),'utf8'));
  if(!Array.isArray(entries)||!entries.length||new Set(entries).size!==entries.length)throw fail('INSTALL_SOURCE','Invalid runtime file inventory.');
  for(const entry of entries){
    if(typeof entry!=='string'||entry.startsWith('/')||entry.includes('\\')||entry.split('/').some(p=>!p||p==='..'||p==='.')||entry.includes(':'))throw fail('INSTALL_SOURCE','Runtime inventory contains an unsafe path.');
    const file=path.join(source,entry),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw fail('INSTALL_SOURCE','Runtime inventory must contain regular files only.');
    const real=await fs.realpath(file),relative=path.relative(await fs.realpath(source),real);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw fail('INSTALL_SOURCE','Runtime file escapes the source directory.');
  }
  return entries;
}

export async function installSkill({source=sourceRoot,destination,emit=()=>{}}={},dependencies={execute:executeNode,npm:npmEntry}) {
  source=await fs.realpath(source);destination=path.resolve(destination||await defaultDestination());
  const inventory=await runtimeInventory(source);
  const pkg=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'));
  const rootLock=JSON.parse(await fs.readFile(path.join(source,'package-lock.json'),'utf8'));
  if(Number(process.versions.node.split('.')[0])<22)throw fail('NODE_VERSION','Install Node.js 22 or newer before setup.');
  const same=await samePath(source,destination);
  if(!same){
    const relative=path.relative(destination,source);
    if(!relative.startsWith('..')&&!path.isAbsolute(relative))throw fail('INSTALL_DESTINATION','The destination cannot contain the source checkout.');
  }
  return withLock((await canonicalDestination(destination))+'.install.lock',async()=>{
    const markerFile=path.join(destination,marker);
    if(!same&&await exists(destination)&&!await exists(markerFile))throw fail('UNMANAGED_INSTALL','The destination already exists and is not managed by this installer. Choose another --destination.');
    // Validate every target before closing a browser or replacing any installed code.
    for(const entry of [...inventory,marker])await validateDestinationFile(destination,path.join(destination,entry),{same});
    const packages=dependencyPackages(rootLock);
    if(!packages)throw fail('INSTALL_SOURCE','The source dependency lockfile is invalid.');
    const wantedFingerprint=dependencyFingerprint(packages),managed=await readJson(markerFile);
    // A legacy version-only marker has no successful-install receipt. npm's hidden
    // lock describes its installed tree, unlike the desired lock copied into the skill.
    const installedFingerprint=managed?.schemaVersion===1?managed.dependencyFingerprint
      :dependencyFingerprint(dependencyPackages(await readJson(path.join(destination,'node_modules','.package-lock.json'))));
    const cli=path.join(destination,'node_modules','@playwright','cli','playwright-cli.js');
    let healthy=false;
    if(await exists(cli)){
      const installedCli=await readJson(path.join(destination,'node_modules/@playwright/cli/package.json'));
      try{await checkCliHealth(cli,{execute:dependencies.execute,cwd:destination,expectedVersion:installedCli?.version});healthy=true;}
      catch(error){if(error.code!=='CLI_UNHEALTHY')throw error;}
    }
    const needsDependencies=!healthy||installedFingerprint!==wantedFingerprint||!await installedVersionsMatch(destination,packages);
    // Resolve npm before changing a healthy installed copy or closing its browser.
    const npm=needsDependencies?await dependencies.npm():null;
    if(needsDependencies&&await exists(markerFile)){
      let closeRoot=destination,closeCli=cli;
      if(!healthy){
        closeRoot=source;closeCli=path.join(source,'node_modules','@playwright','cli','playwright-cli.js');
        // A broken destination cannot confirm shutdown. The source backend can
        // close the same runtime/profile without importing the damaged package.
        await checkCliHealth(closeCli,{execute:dependencies.execute,cwd:source,expectedVersion:packages['node_modules/@playwright/cli']?.version});
      }
      emit('Updating browser dependencies; closing the managed browser while retaining its profile.');
      await dependencies.execute([path.join(closeRoot,'scripts','wa.mjs'),'close'],{cwd:closeRoot,env:{...process.env,WA_PLAYWRIGHT_CLI:closeCli}});
    }
    await fs.mkdir(destination,{recursive:true});
    const state={schemaVersion:1,version:pkg.version,dependencyFingerprint:wantedFingerprint};
    // Establish management on a fresh destination, and force repair after an
    // interrupted dependency update even if its new desired lockfile was copied.
    if(needsDependencies)await writeMarker(markerFile,{...state,dependencyFingerprint:null});
    if(!same)for(const entry of inventory){
      const target=path.join(destination,entry);
      await replaceFile(target,temporary=>fs.copyFile(path.join(source,entry),temporary,constants.COPYFILE_EXCL));
    }
    if(needsDependencies){
      emit('Installing the pinned browser dependency.');
      await dependencies.execute([npm,'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:destination});
      if(!await exists(cli)||!await installedVersionsMatch(destination,packages))throw fail('INSTALL_DEPENDENCIES','The installed browser dependency versions could not be verified. Run setup again to repair them.');
      try{await checkCliHealth(cli,{execute:dependencies.execute,cwd:destination,expectedVersion:packages['node_modules/@playwright/cli']?.version});}
      catch(error){throw fail('INSTALL_DEPENDENCIES','The installed browser dependency could not run. Run setup again to repair it.',{causeCode:error.code});}
    }
    // Browser/Chrome readiness is separate from a completed npm installation.
    // Preserve that evidence if doctor fails so a retry need not reset dependencies.
    await writeMarker(markerFile,state);
    await dependencies.execute([path.join(destination,'scripts','wa.mjs'),'doctor'],{cwd:destination});
    return {skillDirectory:destination,cli:path.join(destination,'scripts','wa.mjs'),version:pkg.version,dependenciesInstalled:needsDependencies};
  });
}

if(await isMain(import.meta.url)){
  try{
    const {values,positionals}=parseArgs({strict:true,allowPositionals:true,options:{destination:{type:'string'},help:{type:'boolean'}}});
    if(values.help)console.log('node scripts/install.mjs [--destination DIRECTORY]\nInstalls code only. Run npm run setup for guided login.');
    else{if(positionals.length)throw fail('BAD_ARGUMENT','Unexpected positional arguments.');console.log(JSON.stringify({ok:true,...await installSkill({destination:values.destination,emit:message=>console.error(message)})}));}
  }catch(e){console.error(`${e.code||'INSTALL_FAILED'}: ${e.message}`);process.exitCode=1;}
}
