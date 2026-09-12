import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './storage.mjs';
import { dataRoot, checkRequirements, samePath } from './platform.mjs';

const require = createRequire(import.meta.url);
export function settings(session='whatsapp-codex') {
  if(!/^[a-z0-9][a-z0-9-]{0,49}$/.test(session)) throw fail('SESSION_NAME','Use 1–50 lowercase letters, digits or hyphens.');
  const root = dataRoot();
  const base = session==='whatsapp-codex' ? root : path.join(root,'sessions',session);
  return {session,root,base,profile:path.join(base,'profile'),cwd:path.join(base,'runtime'),lock:path.join(base,'command.lock')};
}

export async function findCli() {
  const candidates = [];
  if(process.env.WA_PLAYWRIGHT_CLI)candidates.push(process.env.WA_PLAYWRIGHT_CLI);
  else try { candidates.push(require.resolve('@playwright/cli/playwright-cli.js')); } catch {}
  for(const file of candidates.filter(Boolean)) {
    try { if((await fs.stat(file)).isFile()) return path.resolve(file); } catch {}
  }
  throw fail('CLI_MISSING',process.env.WA_PLAYWRIGHT_CLI
    ? 'WA_PLAYWRIGHT_CLI does not point to an existing CLI file. Correct the explicit path before continuing.'
    : 'The pinned local Playwright CLI is missing. Run npm ci --ignore-scripts in this skill directory.');
}

export async function runCli(config, args, timeout=150000, envOverrides={}) {
  const entry = await findCli();
  // The pinned CLI otherwise keys its sessions by its installation directory.
  // A runtime marker keeps the identity stable across projects and skill updates.
  await fs.mkdir(config.base,{recursive:true,mode:0o700});
  await fs.mkdir(path.join(config.cwd,'.playwright'),{recursive:true,mode:0o700});
  if(process.platform!=='win32'){await fs.chmod(config.base,0o700);await fs.chmod(config.cwd,0o700);}
  return new Promise((resolve,reject)=> {
    const child=spawn(process.execPath,[entry,`-s=${config.session}`,...args],{cwd:config.cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,...envOverrides,NO_UPDATE_NOTIFIER:'1'}});
    let stdout='',stderr='',done=false;
    const timer=setTimeout(()=>{child.kill(); finish(fail('COMMAND_TIMEOUT','Browser command timed out. Inspect the page before retrying any mutation.'));},timeout);
    const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(result);};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',s=>stdout+=s); child.stderr.on('data',s=>stderr+=s);
    child.on('error',e=>finish(e));
    child.on('close',(code,signal)=>{
      if(code!==0 || /^### Error/m.test(stdout)) return finish(fail('BROWSER_ERROR',(stdout.match(/### Error\r?\n([\s\S]*?)(?:\r?\n### |$)/)?.[1] || stderr || stdout || `Browser backend exited ${signal ? `with signal ${signal}` : `with code ${code}`}.`).slice(0,1800)));
      finish(null,{stdout,stderr});
    });
  });
}

export async function openBrowser(config,{headed=false,url='https://web.whatsapp.com/'}={},dependencies={check:checkRequirements,run:runCli}){
  const {chrome}=await dependencies.check();
  await fs.mkdir(config.cwd,{recursive:true,mode:0o700});
  const file=path.join(config.cwd,`.wa-browser-${randomUUID()}.json`);
  await fs.writeFile(file,JSON.stringify({browser:{browserName:'chromium',launchOptions:{executablePath:chrome,headless:!headed}}}),{flag:'wx',mode:0o600});
  let keep=false;
  try{
    return await dependencies.run(config,['open',url,'--browser=chrome',...(headed?['--headed']:[]),`--profile=${config.profile}`,`--config=${file}`],150000,
      {PLAYWRIGHT_MCP_EXECUTABLE_PATH:chrome,PLAYWRIGHT_MCP_HEADLESS:String(!headed)});
  }catch(error){keep=error.code==='COMMAND_TIMEOUT';throw error;}
  finally{if(!keep)await fs.rm(file,{force:true});}
}

export async function closeBrowser(config,dependencies={}){
  const info=dependencies.info||sessionInfo,sleep=dependencies.sleep||delay,now=dependencies.now||Date.now;
  const request=dependencies.request||(async c=>{
    await act(c,async page=>{
      const context=page.context();
      // This exact listener belongs to the pinned Playwright CLI daemon. Keep all
      // other close listeners, including Playwright's own completion promise.
      const listeners=context.listeners('close').filter(listener=>{
        const source=Function.prototype.toString.call(listener);
        return source.includes('deleteSessionFile')&&source.includes('gracefullyProcessExitDoNotHang');
      });
      if(listeners.length!==1)throw Object.assign(Error('The browser backend shutdown handler changed. Keep the profile and inspect compatibility before closing.'),{code:'BROWSER_CLOSE_UNSUPPORTED'});
      context.removeListener('close',listeners[0]);
      try{await context.close();}
      catch(error){context.on('close',listeners[0]);throw error;}
      return {browserClosed:true};
    },'close-browser');
    // Chrome has finished closing and flushing the profile; stop its idle daemon.
    await runCli(c,['close']);
  });
  const before=await info(config);
  if(!before.open)return {closed:true,profileRetained:true};
  if(!await samePath(before.profile,config.profile))throw fail('PROFILE_MISMATCH','Refusing to close a browser using another profile.');
  // The pinned backend's stop path can enter shutdown twice and force-kill Chrome
  // on POSIX before cookies are flushed. Complete context.close before daemon stop.
  let error;
  try{await request(config);}catch(e){error=e;}
  // Successful shutdown can disconnect the daemon before its reply arrives.
  // Confirm the result; never fall back to killing a browser with unflushed state.
  const deadline=now()+10000;
  do{
    const current=await info(config);
    if(!current.open)return {closed:true,profileRetained:true};
    if(!await samePath(current.profile,config.profile))throw fail('PROFILE_MISMATCH','The browser profile changed during shutdown. Inspect it before continuing.');
    if(error&&error.code!=='BROWSER_ERROR'&&error.code!=='COMMAND_TIMEOUT')throw error;
    await sleep(100);
  }while(now()<deadline);
  throw fail('BROWSER_CLOSE_PENDING','Chrome has not confirmed shutdown. Leave its profile intact and inspect the browser before retrying.');
}

export function parseResult(stdout) {
  const match=stdout.match(/### Result\r?\n([\s\S]*?)(?:\r?\n### |$)/);
  if(!match) throw fail('RESULT_MISSING','The browser backend returned no structured result. Inspect status/UI.');
  try { return JSON.parse(match[1].trim()); }
  catch { throw fail('RESULT_INVALID','The browser backend returned an invalid result.'); }
}

export async function act(config,fn,operation,args={}) {
  const code=`async (page) => { try { return {value:await (${fn.toString()})(page,${JSON.stringify(operation)},${JSON.stringify(args)})}; } catch(e) { return {waError:{code:e.code||'UI_ERROR',message:e.message,details:e.details}}; } }`;
  await fs.mkdir(config.cwd,{recursive:true});
  const commandFile=path.join(config.cwd,`.wa-command-${randomUUID()}.js`);
  await fs.writeFile(commandFile,code,{flag:'wx',encoding:'utf8'});
  let keepForInspection=false;
  try {
    // The pinned backend supports loading code directly; argv stays short even
    // when exact draft text contains many quotes, newlines or non-ASCII names.
    const {stdout}=await runCli(config,['run-code',`--filename=${commandFile}`]);
    if(/\[File chooser\]/.test(stdout) && !/### Result/.test(stdout)) {
      if(operation==='upload')return {fileChooserPending:true};
      throw fail('FILE_CHOOSER_PENDING','A file chooser is open. Complete the pending upload or cancel the chooser before other actions.');
    }
    const result=parseResult(stdout);
    if(!result || typeof result!=='object' || Array.isArray(result) || (!Object.hasOwn(result,'value')&&!result.waError))throw fail('RESULT_INVALID','The browser backend returned an invalid action result.');
    if(result.waError) throw fail(result.waError.code,result.waError.message,result.waError.details);
    return result.value;
  } catch(e) {
    if(e.code==='COMMAND_TIMEOUT') {
      // The backend may still be executing after its client times out.
      keepForInspection=true;e.details={...e.details,commandFile};
    }
    throw e;
  } finally {
    if(!keepForInspection)await fs.rm(commandFile,{force:true});
  }
}

export async function snapshot(config) {
  const file=path.join(config.cwd,'.wa-snapshot.yml');
  await fs.rm(file,{force:true});
  const {stdout}=await runCli(config,['snapshot',`--filename=${file}`]);
  const fileChooserPending=/\[File chooser\]/.test(stdout);
  let content;try{content=await fs.readFile(file,'utf8');}catch(e){if(!fileChooserPending)throw e;content='';}
  return {snapshot:content,fileChooserPending};
}

export async function sessionInfo(config) {
  const {stdout}=await runCli(config,['list','--json']);
  let data;
  try { data=JSON.parse(stdout);if(!Array.isArray(data.browsers))throw Error('invalid session list'); }
  catch { throw fail('RESULT_INVALID','The browser backend returned an invalid session list.'); }
  const matches=data.browsers.filter(browser=>browser?.name===config.session);
  if(!matches.length) return {open:false,known:false};
  if(matches.length!==1)throw fail('SESSION_AMBIGUOUS','The browser backend returned more than one matching session.');
  const browser=matches[0];
  return {open:browser.status==='open',known:true,profile:typeof browser.userDataDir==='string'?browser.userDataDir:undefined,
    headed:typeof browser.headed==='boolean'?browser.headed:undefined,
    compatible:browser.compatible,persistent:browser.persistent,attached:browser.attached};
}

export async function playwrightModule() {
  const entry=await findCli();
  return createRequire(entry)('playwright');
}
