import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fail} from './storage.mjs';

export function dataRoot({platform=process.platform,env=process.env,home=os.homedir()}={}) {
  const paths=platform==='win32'?path.win32:path.posix;
  if(env.WA_DATA_DIR){
    if(!paths.isAbsolute(env.WA_DATA_DIR))throw fail('DATA_DIRECTORY','WA_DATA_DIR must be absolute so different projects reuse the same login.');
    return paths.normalize(env.WA_DATA_DIR);
  }
  const parent=platform==='win32'?(env.LOCALAPPDATA||paths.join(home,'AppData','Local'))
    :platform==='darwin'?paths.join(home,'Library','Application Support')
    :(env.XDG_DATA_HOME||paths.join(home,'.local','share'));
  if(!paths.isAbsolute(parent))throw fail('DATA_DIRECTORY','The application data directory must be absolute.');
  return paths.join(parent,'codex-whatsapp-web');
}

export function chromeCandidates({platform=process.platform,env=process.env,home=os.homedir()}={}) {
  const paths=platform==='win32'?path.win32:path.posix;
  if(env.WA_CHROME_PATH){
    if(!paths.isAbsolute(env.WA_CHROME_PATH))throw fail('CHROME_PATH','WA_CHROME_PATH must be an absolute Chrome executable or macOS .app path.');
    const explicit=paths.normalize(env.WA_CHROME_PATH);
    return [platform==='darwin'&&/\.app\/?$/i.test(explicit)?paths.join(explicit,'Contents','MacOS','Google Chrome'):explicit];
  }
  if(platform==='win32')return [env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA].filter(Boolean).map(p=>path.win32.join(p,'Google','Chrome','Application','chrome.exe'));
  if(platform==='darwin')return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.posix.join(home,'Applications','Google Chrome.app','Contents','MacOS','Google Chrome')];
  return ['/opt/google/chrome/chrome','/usr/bin/google-chrome','/usr/bin/google-chrome-stable'];
}

export async function checkRequirements({version=process.versions.node,candidates=chromeCandidates(),exists=async file=>{try{return (await fs.stat(file)).isFile();}catch{return false;}}}={}) {
  if(Number(version.split('.')[0])<22)throw fail('NODE_VERSION','Install Node.js 22 or newer from https://nodejs.org/ and restart your terminal.');
  for(const file of candidates)if(await exists(file))return {node:version,chrome:file};
  throw fail('CHROME_MISSING','Install Google Chrome from https://www.google.com/chrome/ and run setup again. No account data was cleared.');
}

export async function executeNode(args,{cwd,env=process.env,timeout=180000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(fail('PROCESS_TIMEOUT','Installation command timed out. Run setup again after inspecting the result.'));},timeout);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
    child.on('error',e=>finish(e));
    child.on('close',code=>code===0?finish(null,{stdout,stderr}):finish(fail('PROCESS_FAILED',(stderr||stdout||`Command exited with code ${code}.`).slice(-2400))));
  });
}

export async function npmEntry({env=process.env,execPath=process.execPath,platform=process.platform,realpath=fs.realpath,isFile=async file=>{try{return (await fs.stat(file)).isFile();}catch{return false;}}}={}) {
  const paths=platform==='win32'?path.win32:path.posix;
  const candidates=[env.npm_execpath],executables=[execPath];
  try{executables.push(await realpath(execPath));}catch{}
  const bins=[...new Set([...executables.map(file=>paths.dirname(file)),...(env.PATH||'').split(paths.delimiter)].filter(directory=>directory&&paths.isAbsolute(directory)))];
  for(const bin of bins){
    candidates.push(paths.join(bin,'node_modules','npm','bin','npm-cli.js'));
    candidates.push(paths.resolve(bin,'..','lib','node_modules','npm','bin','npm-cli.js'));
    if(platform!=='win32')try{candidates.push(await realpath(paths.join(bin,'npm')));}catch{}
  }
  for(const file of [...new Set(candidates.filter(Boolean))]){
    if(!paths.isAbsolute(file)||paths.basename(file)!=='npm-cli.js')continue;
    if(await isFile(file))return file;
  }
  throw fail('NPM_MISSING','Run setup through npm run setup, or install Node.js with npm included.');
}

// macOS can use either case-sensitive or case-insensitive volumes. Resolve real
// aliases instead of lowercasing every path or assuming /var and /private/var differ.
export async function samePath(left,right,{paths=path,realpath=fs.realpath,stat=fs.stat}={}) {
  if(typeof left!=='string'||typeof right!=='string'||!left||!right)return false;
  const a=paths.resolve(left),b=paths.resolve(right);
  if(a===b)return true;
  try{
    const [realA,realB]=await Promise.all([realpath(a),realpath(b)]);
    if(realA===realB)return true;
    const [statA,statB]=await Promise.all([stat(realA,{bigint:true}),stat(realB,{bigint:true})]);
    return statA.dev===statB.dev&&statA.ino===statB.ino&&BigInt(statA.ino)!==0n;
  }catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return false;throw error;}
}

export async function isMain(metaUrl){
  return !!process.argv[1]&&await samePath(process.argv[1],fileURLToPath(metaUrl));
}
