#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {fail,withLock} from './storage.mjs';
import {executeNode,npmEntry,samePath,isMain} from './platform.mjs';

const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const marker='.whatsapp-web-managed';
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};

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
    if(await exists(destination)&&!await exists(path.join(destination,marker)))throw fail('UNMANAGED_INSTALL','The destination already exists and is not managed by this installer. Choose another --destination.');
  }
  return withLock(destination+'.install.lock',async()=>{
    let oldLock;try{oldLock=JSON.parse(await fs.readFile(path.join(destination,'package-lock.json'),'utf8'));}catch{}
    const packageDependencies=lock=>Object.fromEntries(Object.entries(lock?.packages||{}).filter(([name])=>name));
    const cli=path.join(destination,'node_modules','@playwright','cli','playwright-cli.js');
    const needsDependencies=!await exists(cli)||JSON.stringify(packageDependencies(oldLock))!==JSON.stringify(packageDependencies(rootLock));
    if(!same&&needsDependencies&&await exists(path.join(destination,marker))&&await exists(cli)){
      emit('Updating browser dependencies; closing the managed browser while retaining its profile.');
      await dependencies.execute([path.join(destination,'scripts','wa.mjs'),'close'],{cwd:destination});
    }
    await fs.mkdir(destination,{recursive:true});
    if(!same)for(const entry of inventory){
      const target=path.join(destination,entry);
      // Refuse symlinked destination components before replacing a managed file.
      let cursor=target;
      while(cursor!==path.dirname(destination)){
        try{if((await fs.lstat(cursor)).isSymbolicLink())throw fail('INSTALL_DESTINATION','Destination files/directories cannot be symbolic links.');}catch(e){if(e.code!=='ENOENT')throw e;}
        if(cursor===destination)break;cursor=path.dirname(cursor);
      }
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.copyFile(path.join(source,entry),target);
    }
    await fs.writeFile(path.join(destination,marker),pkg.version+'\n');
    if(needsDependencies){
      emit('Installing the pinned browser dependency.');
      await dependencies.execute([await dependencies.npm(),'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:destination});
    }
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
