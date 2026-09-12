#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fail} from './storage.mjs';
import {runtimeInventory} from './install.mjs';
import {samePath,isMain} from './platform.mjs';

const exec=promisify(execFile);
const forbidden=new Set(['node_modules','.work','work','profile','profiles','runtime','sessions','downloads','uploads','screenshots','.playwright','.playwright-cli','.git','send-resolutions']);

export function publicPath(file){
  if(typeof file!=='string'||!file||file.includes('\\')||file.includes(':')||file.startsWith('/'))return false;
  const parts=file.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||forbidden.has(p.toLowerCase())))return false;
  const name=parts.at(-1).toLowerCase();
  if(name==='state.md'||name.startsWith('.env')||name.startsWith('.wa-')||name==='.whatsapp-web-managed'||/^(wa-manifest|prepared-draft|pending-upload|pending-ui)\.json$/.test(name))return false;
  return file==='docs/assets/hero.svg'||/\.(mjs|json|md|ps1|ya?ml)$/.test(name)||['license','.gitignore','.gitattributes'].includes(name);
}

export function inspectPublicText(file,text){
  const patterns=[
    ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['access token',/\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
    ['cloud access key',/\bAKIA[A-Z0-9]{16}\b/],
    ['account identifier',/\b\d{7,}@(c\.us|s\.whatsapp\.net|g\.us)\b/],
    ['personal Windows path',/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+[\\/]/i],
    ['personal macOS path',/\/Users\/[^/\s"'<>]+\//],
    ['binary data',/\u0000/]
  ];
  for(const [kind,pattern] of patterns)if(pattern.test(text))throw fail('PRIVATE_RELEASE_CONTENT',`Possible ${kind} in ${file}. Inspect locally; do not publish raw matches.`);
}

export async function checkRelease(root=fileURLToPath(new URL('../',import.meta.url))){
  root=await fs.realpath(root);
  const files=JSON.parse(await fs.readFile(path.join(root,'release-files.json'),'utf8'));
  if(!Array.isArray(files)||!files.length||new Set(files).size!==files.length)throw fail('RELEASE_INVENTORY','Release inventory must be a nonempty list of unique files.');
  for(const file of files){
    if(!publicPath(file))throw fail('PRIVATE_RELEASE_PATH',`Not a publishable source path: ${file}`);
    const target=path.join(root,file),stat=await fs.lstat(target),real=await fs.realpath(target);
    const relative=path.relative(root,real);
    if(!stat.isFile()||stat.isSymbolicLink()||relative.startsWith('..')||path.isAbsolute(relative))throw fail('RELEASE_FILE','Release files must be regular files within the source root.');
    if(stat.size>2_000_000)throw fail('RELEASE_FILE',`Unexpectedly large source file: ${file}`);
    const text=await fs.readFile(target,'utf8');inspectPublicText(file,text);
    if(file.endsWith('.md'))for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
      const link=match[1].split('#')[0];if(!link||/^[a-z]+:/i.test(link))continue;
      const resolved=path.relative(root,path.resolve(path.dirname(target),link)).split(path.sep).join('/');
      if(!files.includes(resolved))throw fail('RELEASE_LINK',`Broken or unlisted local link in ${file}: ${link}`);
    }
  }
  const runtime=await runtimeInventory(root);
  for(const file of runtime)if(!files.includes(file))throw fail('RELEASE_INVENTORY',`Runtime file is not in the release inventory: ${file}`);
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const lock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
  if(pkg.license!=='MIT'||pkg.private!==true||!Array.isArray(pkg.files)||pkg.name!==lock.name||pkg.version!==lock.version)throw fail('PACKAGE_METADATA','Package/license metadata or source-only publication guard is inconsistent.');
  // Extracted source archives need neither Git nor macOS Command Line Tools.
  let gitRoot;
  let hasGit=false;try{await fs.lstat(path.join(root,'.git'));hasGit=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(hasGit){
    try{gitRoot=(await exec('git',['-C',root,'rev-parse','--show-toplevel'],{windowsHide:true})).stdout.trim();}
    catch{throw fail('RELEASE_GIT','This checkout has Git metadata but cannot be inspected. Install Git before creating a source release.');}
  }
  let gitChecked=false;
  if(gitRoot&&await samePath(gitRoot,root)){
    const tracked=(await exec('git',['-C',root,'ls-files','-z'],{windowsHide:true})).stdout.split('\0').filter(Boolean);
    const extra=tracked.filter(file=>!files.includes(file)),missing=files.filter(file=>!tracked.includes(file));
    if(extra.length||missing.length)throw fail('RELEASE_INDEX','Tracked files differ from the release inventory. Stage only reviewed inventory files.',{extra,missing});
    try{await exec('git',['-C',root,'diff','--exit-code','--name-only','--'],{windowsHide:true});}
    catch{throw fail('RELEASE_INDEX','Unstaged source changes remain. Stage the reviewed files before checking/exporting the release.');}
    gitChecked=true;
  }
  return {version:pkg.version,files:files.length,runtimeFiles:runtime.length,gitChecked,privateArtifactsIncluded:false};
}

if(await isMain(import.meta.url)){
  try{console.log(JSON.stringify({ok:true,...await checkRelease()}));}
  catch(e){console.error(`${e.code||'RELEASE_CHECK_FAILED'}: ${e.message}`);if(e.details)console.error(JSON.stringify(e.details));process.exitCode=1;}
}
