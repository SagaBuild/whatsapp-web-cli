#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { browserAction } from './browser.mjs';
import { settings, findCli, runCli, act, snapshot, sessionInfo, openBrowser, closeBrowser } from './transport.mjs';
import { fail, withLock, saveDownload, safeFilename, hashFile } from './storage.mjs';
import { checkRequirements, samePath, isMain } from './platform.mjs';

const help={
  usage:'node <skill>/scripts/wa.mjs COMMAND [OPTIONS]',
  commands:{
    doctor:'Check runtime and absolute session paths.',
    open:'Open the persistent linked Chrome profile in the background. --headed shows a desktop window. An existing browser is reused without restarting.',
    status:'Return login state and the currently selected chat.',
    close:'Close this browser; retain the profile and login.',
    chats:'[--query TEXT] Search/list loaded chat results.',
    chat:'--name EXACT_TITLE Search and open one exact match.',
    messages:'--chat TITLE [--older 0..50] [--limit 1..500] [--contains TEXT] Read partial loaded history.',
    links:'--chat TITLE [--older N] [--open URL] Extract full links, optionally open one observed link.',
    download:'--chat TITLE (--message ID [--item 0] | --all) --out DIRECTORY [--timeout 90000] Save originals with verified receipts.',
    compose:'--chat TITLE --text-file PATH Prepare a text draft. Does not send.',
    upload:'--chat TITLE --file PATH [--file PATH...] Stage documents. Does not send.',
    send:'--chat TITLE --authorized Send the prepared draft only under an explicit user instruction. Never auto-retry uncertainty.',
    'send-check':'--chat TITLE Check a recorded uncertain send without clicking Send again.',
    'send-resolve':'--chat TITLE --outcome sent|not-sent --inspected Record a manually inspected uncertain-send outcome locally, then clear its preparation. Does not verify delivery or send.',
    ui:'snapshot | screenshot --out FILE | tabs | tab INDEX | click REF | hover REF | fill REF --text-file FILE | press KEY | upload --file PATH | scroll DX DY. UI actions require --chat TITLE; preserve user authorization boundaries.'
  },
  global:'--session NAME (default whatsapp-codex). WA_DATA_DIR overrides private session storage; WA_CHROME_PATH selects a Chrome executable or macOS .app; WA_PLAYWRIGHT_CLI points to playwright-cli.js.',
  coverage:'Loaded messages are not a complete chat export. Open the chat before using --chat commands. Use the same session for cross-project continuity.',
  privacy:'No project-operated backend or telemetry. WhatsApp uses the network; CLI data read by an AI agent enters its context. Account profiles and runtime files stay on this device.'
};

function number(value,fallback,min,max) {
  const n=value===undefined?fallback:Number(value);
  if(!Number.isInteger(n)||n<min||n>max) throw fail('BAD_ARGUMENT',`Expected an integer from ${min} to ${max}.`);
  return n;
}

async function readState(file) {
  try{return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw fail('STATE_INVALID','Local preparation metadata is unreadable. Inspect the draft before preparing it again.');}
}

async function writeState(file,value) {
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temporary,file);}
  finally{await fs.rm(temporary,{force:true});}
}

export async function stageFiles(config,chat,originals) {
  const folder=path.join(config.cwd,'uploads',randomUUID());await fs.mkdir(folder,{recursive:true});
  const staged=[],hashes=[],used=new Set();
  for(const original of originals){
    const wanted=safeFilename(path.basename(original)),ext=path.extname(wanted),stem=wanted.slice(0,wanted.length-ext.length);
    let name=wanted,index=0;
    while(used.has(name.toLowerCase()))name=`${stem} (${++index})${ext}`;
    used.add(name.toLowerCase());
    const file=path.join(folder,name);
    await fs.copyFile(original,file,constants.COPYFILE_EXCL);
    staged.push(file);hashes.push((await hashFile(file)).sha256);
  }
  const prepared={chat,originals,staged,hashes,createdAt:new Date().toISOString()};
  await verifyFiles(prepared);
  return prepared;
}

export async function verifyFiles(prepared) {
  if(!Array.isArray(prepared.originals)||!prepared.originals.length||!Array.isArray(prepared.staged)||!Array.isArray(prepared.hashes)||prepared.originals.length!==prepared.staged.length||prepared.staged.length!==prepared.hashes.length)throw fail('STATE_INVALID','Upload metadata is incomplete. Inspect the existing preview before preparing files again.');
  for(let i=0;i<prepared.originals.length;i++){
    for(const file of [prepared.originals[i],prepared.staged[i]]){
      let actual;try{actual=await hashFile(file);}catch{throw fail('UPLOAD_CHANGED','A prepared source or staging file is no longer readable. Inspect the existing preview.');}
      if(actual.sha256!==prepared.hashes[i])throw fail('UPLOAD_CHANGED','A prepared source or staging file changed. Inspect the existing preview before starting again.');
    }
  }
}

export async function main(argv,backend={settings,findCli,runCli,act,snapshot,sessionInfo,openBrowser,closeBrowser}) {
  const {settings,findCli,runCli,act,snapshot,sessionInfo,openBrowser,closeBrowser}=backend;
  const parsed=parseArgs({args:argv,allowPositionals:true,strict:true,options:{
    session:{type:'string'},chat:{type:'string'},name:{type:'string'},query:{type:'string'},
    older:{type:'string'},limit:{type:'string'},contains:{type:'string'},message:{type:'string'},item:{type:'string'},
    out:{type:'string'},all:{type:'boolean'},timeout:{type:'string'},file:{type:'string',multiple:true},
    'text-file':{type:'string'},authorized:{type:'boolean'},open:{type:'string'},help:{type:'boolean'},
    outcome:{type:'string'},inspected:{type:'boolean'},headed:{type:'boolean'}
  }});
  let [command='help',...pos]=parsed.positionals;
  const o=parsed.values;
  if(command==='ui'&&pos[0]==='upload'){command='upload';pos=pos.slice(1);}
  if(command==='help'||o.help)return help;
  const allowed={doctor:[],open:['headed'],status:[],close:[],chats:['query'],chat:['name'],messages:['chat','older','limit','contains'],links:['chat','older','limit','contains','open'],download:['chat','message','item','all','out','timeout'],compose:['chat','text-file'],upload:['chat','file'],send:['chat','authorized'],'send-check':['chat'],'send-resolve':['chat','outcome','inspected'],ui:['chat','out','text-file']};
  if(!allowed[command])throw fail('UNKNOWN_COMMAND',`Unknown command: ${command}`);
  for(const option of Object.keys(o))if(!['session','help',...allowed[command]].includes(option))throw fail('BAD_ARGUMENT',`--${option} is not supported by ${command}.`);
  if(command!=='ui'&&pos.length)throw fail('BAD_ARGUMENT',`Unexpected positional arguments for ${command}.`);
  const config=settings(o.session);
  if(command==='doctor')return {...await checkRequirements(),backend:await findCli(),...config};
  return withLock(config.lock,async()=>{
    const call=(op,args={})=>act(config,browserAction,op,args);
    const preparedFile=path.join(config.base,'prepared-draft.json');
    if(command==='compose'||command==='upload') {
      const prepared=await readState(preparedFile);
      if(prepared?.attempt)throw fail('SEND_UNCERTAIN','A send attempt is unresolved in this session. Use send-check and inspect that chat before preparing any other content.',{chat:prepared.chat,attemptedAt:prepared.attempt.at});
    }
    if(command==='send-resolve') {
      if(!o.chat)throw fail('CHAT_REQUIRED','Supply the exact chat title for the recorded send attempt.');
      if(!['sent','not-sent'].includes(o.outcome))throw fail('BAD_ARGUMENT','Use --outcome sent or --outcome not-sent after inspecting the actual chat UI/history.');
      if(o.inspected!==true)throw fail('INSPECTION_REQUIRED','Inspect the actual chat UI/history first, then supply --inspected to record that manual conclusion.');
      const prepared=await readState(preparedFile);
      if(!prepared?.attempt)throw fail('NO_SEND_ATTEMPT','This session has no recorded send attempt to resolve.');
      if(prepared.chat!==o.chat)throw fail('DRAFT_MISMATCH','The recorded send attempt belongs to another chat.');
      const receipt={schemaVersion:1,resolutionId:randomUUID(),session:config.session,chat:prepared.chat,
        attemptedAt:prepared.attempt.at||null,resolvedAt:new Date().toISOString(),kind:prepared.kind,
        outcome:o.outcome,basis:'manual_ui_history_inspection',automatedDeliveryVerification:false};
      const directory=path.join(config.base,'send-resolutions');
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const receiptPath=path.join(directory,receipt.resolutionId+'.json');
      // Persist the manual conclusion before removing the duplicate-send guard.
      await writeState(receiptPath,receipt);
      await fs.rm(preparedFile,{force:true});
      await fs.rm(path.join(config.base,'pending-upload.json'),{force:true});
      await fs.rm(path.join(config.base,'pending-ui.json'),{force:true});
      return {chat:prepared.chat,status:'send_resolved_manually',outcome:o.outcome,
        automatedDeliveryVerification:false,receiptPath};
    }
    const savePrepared=async(pending)=>{
      await verifyFiles(pending);
      await writeState(preparedFile,{...pending,kind:'files',names:pending.staged.map(f=>path.basename(f))});
    };
    const session=await sessionInfo(config);
    const matchingProfile=await samePath(session.profile,config.profile);
    if(session.open&&!matchingProfile)throw fail('PROFILE_MISMATCH','This session belongs to a different browser profile. Inspect the session configuration before controlling it.');
    if(command==='open') {
      if(session.open) {
        if(o.headed&&session.headed===false)throw fail('BROWSER_MODE','This browser is running in the background. Finish any pending preview, then run close followed by open --headed to show a window. The same login is retained.');
        try {return {...await call('status',{wait:true}),reused:true,headed:session.headed};}
        catch(e) {if(e.code!=='WRONG_ORIGIN')throw e;}
        const tabs=(await runCli(config,['tab-list'])).stdout;
        const tab=tabs.match(/^- (\d+):.*\]\(https:\/\/web\.whatsapp\.com(?:\/[^)]*)?\)/m);
        if(tab)await runCli(config,['tab-select',tab[1]]);
        else await runCli(config,['tab-new','https://web.whatsapp.com/']);
        return {...await call('status',{wait:true}),reused:true,headed:session.headed};
      }
      await openBrowser(config,{headed:o.headed===true});
      return {...await call('status',{wait:true}),reused:false,profile:config.profile,headed:o.headed===true};
    }
    if(command==='close') {if(session.open)await closeBrowser(config);return {closed:true,loginRetained:true};}
    if(!session.open)throw fail('SESSION_CLOSED','Run open to reuse the persistent WhatsApp profile.');
    if(command==='status')return {...await call('status'),headed:session.headed,pendingSend:(await readState(preparedFile))?.attempt?.at||null};
    if(command==='chats')return call('chats',{query:o.query});
    if(command==='chat')return call('chat',{name:o.name});
    if(command==='messages'||command==='links') {
      if(o.open)return call('open-link',{chat:o.chat,url:o.open});
      return call(command,{chat:o.chat,older:number(o.older,0,0,50),limit:number(o.limit,100,1,500),contains:o.contains});
    }
    if(command==='download') {
      if(!o.out || (!o.message&&!o.all) || (o.message&&o.all))throw fail('BAD_ARGUMENT','Use --out and exactly one of --message or --all.');
      await call('guard',{chat:o.chat});
      const timeout=number(o.timeout,90000,1000,120000);
      let targets;
      if(o.message) targets=[{messageId:o.message,item:number(o.item,0,0,100)}];
      else {
        const {messages}=await call('messages',{chat:o.chat,limit:500});
        targets=messages.flatMap(m=>m.attachments.map(f=>({messageId:m.id,item:f.item})));
        if(!targets.length) throw fail('NO_ATTACHMENTS','No supported attachment controls found in currently loaded messages.');
      }
      const results=[];
      for(const target of targets) {
        try {
          const source={session:config.session,profile:config.profile,chat:o.chat,messageId:target.messageId,item:target.item};
          results.push(await saveDownload(o.out,source,savePath=>call('download',{chat:o.chat,message:target.messageId,item:target.item,savePath,timeout})));
        } catch(e) {
          if(!o.all)throw e;
          results.push({...target,status:'failed',error:{code:e.code||'ERROR',message:e.message}});
          if(!['ATTACHMENT_NOT_FOUND','MESSAGE_NOT_LOADED','EMPTY_DOWNLOAD','DOWNLOAD_FAILED'].includes(e.code))break;
        }
      }
      const failed=results.filter(r=>r.status==='failed').length;
      return {chat:o.chat,coverage:'currently_loaded_attachments_only',requested:targets.length,processed:results.length,failed,
        partial:failed>0||results.length<targets.length,results};
    }
    const text=async()=>{
      if(!o['text-file'])throw fail('BAD_ARGUMENT','Use --text-file PATH to pass exact text without shell interpolation.');
      return fs.readFile(path.resolve(o['text-file']),'utf8');
    };
    const files=async()=>{
      if(!o.file?.length)throw fail('BAD_ARGUMENT','Use --file PATH.');
      const list=o.file.map(f=>path.resolve(f));
      for(const f of list)if(!(await fs.stat(f)).isFile())throw fail('BAD_FILE','Upload path must be a file.');
      return list;
    };
    const stage=originals=>stageFiles(config,o.chat,originals);
    if(command==='compose') {
      const content=await text();if(!content.trim())throw fail('EMPTY_DRAFT','Text is empty.');
      const result=await call('compose',{chat:o.chat,text:content});
      await writeState(preparedFile,{chat:o.chat,kind:'text',text:content});
      return result;
    }
    if(command==='upload') {
      const originals=await files(), pendingFile=path.join(config.base,'pending-upload.json');
      const state=(await runCli(config,['snapshot'])).stdout;
      let pending=await readState(pendingFile);
      const matching=pending && pending.chat===o.chat && JSON.stringify(pending.originals)===JSON.stringify(originals);
      if(matching && !/\[File chooser\]/.test(state)) {
        try {
          const result=await call('verify-upload',{chat:o.chat,files:pending.staged,quick:true});
          await savePrepared(pending);
          await fs.rm(pendingFile,{force:true});return {...result,files:originals,recoveredPreview:true};
        } catch(e) {if(e.code!=='NO_PREVIEW')throw e;}
      }
      if(/\[File chooser\]/.test(state)) {
        if(!matching) {
          const ui=await readState(path.join(config.base,'pending-ui.json'));
          if(!ui || ui.chat!==o.chat || !Number.isFinite(ui.at) || Date.now()-ui.at<0 || Date.now()-ui.at>120000)throw fail('UNBOUND_FILE_CHOOSER','Cancel the existing file chooser, then run upload again. This command did not open it for the requested files/chat.');
          pending=await stage(originals);await writeState(pendingFile,pending);
        }
        await verifyFiles(pending);
      } else {
        await call('guard',{chat:o.chat});
        pending=await stage(originals);
        const staged=pending.staged;
        await writeState(pendingFile,pending);
        const start=await call('upload',{chat:o.chat,files:staged});
        if(!start.fileChooserPending) {
          const result=await call('verify-upload',{chat:o.chat,files:staged});
          await savePrepared(pending);
          await fs.rm(pendingFile,{force:true});return {...result,files:originals};
        }
      }
      await runCli(config,['upload',...pending.staged]);
      const result=await call('verify-upload',{chat:o.chat,files:pending.staged});
      await savePrepared(pending);
      await fs.rm(pendingFile,{force:true});await fs.rm(path.join(config.base,'pending-ui.json'),{force:true});return {...result,files:originals};
    }
    if(command==='send'||command==='send-check') {
      if(command==='send'&&o.authorized!==true)throw fail('SEND_AUTHORIZATION','send requires --authorized and an explicit user request for this content and chat.');
      const expected=await readState(preparedFile);
      if(!expected)throw fail('DRAFT_NOT_PREPARED','Use compose or upload to prepare the content before send.');
      if(expected.chat!==o.chat)throw fail('DRAFT_MISMATCH','The preparation belongs to another chat.');
      let result;
      if(command==='send-check'){
        if(!expected.attempt)throw fail('NO_SEND_ATTEMPT','This draft has no recorded send attempt.');
        result=await call('send-check',{chat:o.chat,expected,before:expected.attempt.before});
        if(result.status!=='outgoing_message_observed')return result;
      }else{
        if(expected.attempt)throw fail('SEND_UNCERTAIN','This draft already has a recorded send attempt. Use send-check and inspect the chat; do not click Send again automatically.');
        if(expected.kind==='files')await verifyFiles(expected);
        const {before}=await call('prepare-send',{chat:o.chat,authorized:true,expected});
        expected.attempt={at:new Date().toISOString(),before};await writeState(preparedFile,expected);
        try{result=await call('send',{chat:o.chat,authorized:true,expected});}
        catch(e){
          if(['DRAFT_CHANGED','DRAFT_MISMATCH','SEND_CONTROL','SEND_AUTHORIZATION','WRONG_CHAT','WRONG_ORIGIN','LOGIN_REQUIRED','CHAT_REQUIRED','COMMAND_TOO_LARGE'].includes(e.code)){
            delete expected.attempt;await writeState(preparedFile,expected);throw e;
          }
          throw fail('SEND_UNCERTAIN','Send may have been activated. Use send-check and inspect the chat; do not retry automatically.',{cause:e.code||'ERROR'});
        }
      }
      await fs.rm(preparedFile,{force:true});
      await fs.rm(path.join(config.base,'pending-upload.json'),{force:true});
      return result;
    }
    if(command==='ui') {
      const [action,...args]=pos;
      if(action==='tabs')return {tabs:(await runCli(config,['tab-list'])).stdout};
      if(action==='tab') { const index=number(args[0],-1,0,100);await runCli(config,['tab-select',String(index)]);return {tab:index}; }
      if(action==='snapshot')return snapshot(config);
      await call('guard',{chat:o.chat});
      if(action==='screenshot') {
        if(!o.out)throw fail('BAD_ARGUMENT','Supply --out FILE.');
        const filename=path.resolve(o.out);await fs.mkdir(path.dirname(filename),{recursive:true});
        await runCli(config,['screenshot',`--filename=${filename}`]);return {path:filename};
      }
      const ref=()=>{if(!/^e\d+$/.test(args[0]||''))throw fail('BAD_REF','Use an e-number from a fresh ui snapshot.');return args[0];};
      let cliArgs;
      if(action==='click'||action==='hover')cliArgs=[action,ref()];
      else if(action==='fill')cliArgs=['fill',ref(),await text()];
      else if(action==='press') {if(!args[0])throw fail('BAD_ARGUMENT','Supply a key.');cliArgs=['press',args[0]];}
      else if(action==='scroll')cliArgs=['mousewheel',String(number(args[0],0,-5000,5000)),String(number(args[1],0,-5000,5000))];
      else throw fail('BAD_UI_ACTION','See help for supported UI commands.');
      const {stdout}=await runCli(config,cliArgs);
      const fileChooserPending=/\[File chooser\]/.test(stdout);
      if(fileChooserPending)await fs.writeFile(path.join(config.base,'pending-ui.json'),JSON.stringify({chat:o.chat,at:Date.now()}));
      else await fs.rm(path.join(config.base,'pending-ui.json'),{force:true});
      return {action,performed:true,fileChooserPending,next:fileChooserPending?'Run ui upload with the intended --file paths and --chat.':'Inspect ui snapshot to verify the result.'};
    }
    throw fail('UNKNOWN_COMMAND',`Unknown command: ${command}`);
  });
}

if(await isMain(import.meta.url)) {
  const command=process.argv[2]||'help';
  try {
    const data=await main(process.argv.slice(2));
    const partial=data?.partial===true;
    process.stdout.write(JSON.stringify({ok:!partial,command,data})+'\n');
    if(partial)process.exitCode=2;
  } catch(e) {
    process.stdout.write(JSON.stringify({ok:false,command,error:{code:e.code||'ERROR',message:e.message,details:e.details}})+'\n');
    process.exitCode=1;
  }
}
