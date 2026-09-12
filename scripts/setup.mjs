#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {installSkill} from './install.mjs';
import {checkRequirements,samePath,isMain} from './platform.mjs';
import {settings,findCli,sessionInfo,runCli,act,openBrowser,closeBrowser} from './transport.mjs';
import {browserAction} from './browser.mjs';
import {fail,withLock} from './storage.mjs';

export const linkInstructions='In WhatsApp on your phone, open Settings (iPhone) or the menu (Android), then Linked devices > Link a device. Scan the QR code in the official web.whatsapp.com Chrome window. Leave Stay logged in enabled if that option appears. Never paste the QR code, a login code or your browser profile into an issue or chat.';

export async function openLoginWindow(config,backend={sessionInfo,runCli,act,openBrowser,closeBrowser}){
  const {sessionInfo,runCli,act,openBrowser,closeBrowser}=backend;
  return withLock(config.lock,async()=>{
    const info=await sessionInfo(config);
    if(info.open){
      if(!await samePath(info.profile,config.profile))throw fail('PROFILE_MISMATCH','The browser session uses another profile. Inspect its configuration before setup.');
      let state;
      try{state=await act(config,browserAction,'connection',{wait:true});}catch(e){if(e.code!=='WRONG_ORIGIN')throw e;}
      if(!state){
        const tabs=(await runCli(config,['tab-list'])).stdout;
        const tab=tabs.match(/^- (\d+):.*\]\(https:\/\/web\.whatsapp\.com(?:\/[^)]*)?\)/m);
        await runCli(config,tab?['tab-select',tab[1]]:['tab-new','https://web.whatsapp.com/']);
        state=await act(config,browserAction,'connection',{wait:true});
      }
      if(info.headed!==false||state.authenticated)return {...state,reused:true,headed:info.headed};
      // An unlinked background session cannot display its QR code to the user.
      await closeBrowser(config);
    }
    await openBrowser(config,{headed:true});
    return {...await act(config,browserAction,'connection',{wait:true}),reused:false,headed:true};
  });
}

export async function onboard({session='whatsapp-codex',timeoutMs=180000,signal}={},dependencies={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>900000)throw fail('BAD_ARGUMENT','Login timeout must be between 0 and 900 seconds.');
  const config=dependencies.config||settings(session),emit=dependencies.emit||(()=>{}),now=dependencies.now||Date.now;
  const open=dependencies.open||(()=>openLoginWindow(config));
  const status=dependencies.status||(()=>withLock(config.lock,()=>act(config,browserAction,'connection')));
  const sleep=dependencies.sleep||((ms)=>delay(ms,undefined,{signal}));
  emit('Opening the saved WhatsApp profile.');
  let state=await open();
  const alreadyLinked=state.authenticated===true;
  const headed=state.headed;
  const deadline=now()+timeoutMs;
  if(!alreadyLinked)emit(linkInstructions);
  while(!state.authenticated){
    if(signal?.aborted)throw fail('SETUP_INTERRUPTED','Setup stopped. Your profile and browser were retained; run setup again to continue.');
    if(now()>=deadline)return {ready:false,state:'login_pending',session:config.session,profile:config.profile,headed,next:'Complete linking in the open Chrome window and rerun setup. The same profile will be reused.'};
    await sleep(Math.min(1500,deadline-now()));
    state=await status();
  }
  return {ready:true,state:'ready',session:config.session,profile:config.profile,alreadyLinked,headed};
}

export async function setup(argv,dependencies={}){
  const {values:o,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{destination:{type:'string'},session:{type:'string'},timeout:{type:'string'},'skip-install':{type:'boolean'},'skip-login':{type:'boolean'},json:{type:'boolean'},help:{type:'boolean'}}});
  if(o.help)return {help:'npm run setup -- [--destination DIRECTORY] [--session NAME] [--timeout SECONDS] [--skip-login] [--skip-install] [--json]\nDefault: install the skill, open the saved profile, wait up to 180 seconds for phone linking. Never sends messages.'};
  if(positionals.length)throw fail('BAD_ARGUMENT','Unexpected positional arguments.');
  if(o['skip-install']&&o.destination)throw fail('BAD_ARGUMENT','--skip-install uses this copy; omit --destination.');
  const seconds=o.timeout===undefined?180:Number(o.timeout);
  if(!Number.isInteger(seconds)||seconds<0||seconds>900)throw fail('BAD_ARGUMENT','--timeout must be an integer from 0 to 900 seconds.');
  settings(o.session);
  const emit=dependencies.emit||((message)=>console.error(message));
  await (dependencies.check||checkRequirements)();
  const installed=o['skip-install']?{skillDirectory:fileURLToPath(new URL('../',import.meta.url)),cli:fileURLToPath(new URL('./wa.mjs',import.meta.url))}
    :await (dependencies.install||installSkill)({destination:o.destination,emit});
  if(o['skip-install'])await (dependencies.findCli||findCli)();
  if(o['skip-login'])return {ready:false,state:'installed',...installed,next:'Run setup again without --skip-login to link WhatsApp.'};
  const result=await (dependencies.onboard||onboard)({session:o.session,timeoutMs:seconds*1000,signal:dependencies.signal},{emit});
  return {...installed,...result};
}

if(await isMain(import.meta.url)){
  const abort=new AbortController();process.once('SIGINT',()=>abort.abort());
  try{
    const result=await setup(process.argv.slice(2),{signal:abort.signal});
    if(process.argv.includes('--json'))console.log(JSON.stringify({ok:true,...result}));
    else if(result.help)console.log(result.help);
    else if(result.ready)console.log(`Ready. ${result.alreadyLinked?'Your saved login was reused.':'Your account is linked; future runs reuse this login.'}\nUse $whatsapp-web in Codex. If it does not appear, restart Codex.\nCLI: ${result.cli}\nPrivate profile: ${result.profile}${result.headed?'\nFor background use, close this browser after linking, then run the CLI open command. Your login is retained.':''}`);
    else console.log(`${result.state==='installed'?'Skill installed.':'Login is not confirmed yet.'}\n${result.next}\nCLI: ${result.cli}`);
    if(result.state==='login_pending')process.exitCode=2;
  }catch(e){
    const interrupted=abort.signal.aborted||e.name==='AbortError';
    const error={code:interrupted?'SETUP_INTERRUPTED':e.code||'SETUP_FAILED',message:interrupted?'Setup stopped. Your saved profile is retained. Run setup again to continue.':e.message};
    if(process.argv.includes('--json'))console.log(JSON.stringify({ok:false,error}));else console.error(`${error.code}: ${error.message}`);
    process.exitCode=interrupted?130:1;
  }
}
