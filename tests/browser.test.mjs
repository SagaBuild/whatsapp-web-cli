import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {browserAction} from '../scripts/browser.mjs';
import {playwrightModule} from '../scripts/transport.mjs';
import {saveDownload} from '../scripts/storage.mjs';
import {checkRequirements} from '../scripts/platform.mjs';

const scratch=fileURLToPath(new URL('../.work/browser-tests/',import.meta.url));
await fs.mkdir(scratch,{recursive:true});
const root=await fs.mkdtemp(path.join(scratch,'run-'));
const zip=Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==','base64');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1sAAAAASUVORK5CYII=','base64');
let server,browser,url;
const html=`<!doctype html><meta charset="utf-8"><style>[hidden]{display:none!important}#main{display:block}footer [contenteditable]{border:1px solid #ddd;min-height:30px}</style>
<div id="side"><input role="textbox" aria-label="Search"></div>
<div id="pane-side"><div role="row"><button title="Team A" onclick="document.querySelector('header').textContent='Team A'">Team A</button></div><div role="row"><button title="Duplicate">Duplicate</button></div><div role="row"><button title="Duplicate">Duplicate</button></div></div>
<div id="main"><header>Team A</header><div data-testid="conversation-panel-messages" style="height:300px;overflow:auto">
<div data-id="doc1"><span data-pre-plain-text="[10:00, 9/12/2026] Test: ">Document</span><a role="button" href="/zip" download="挪威语.zip" title='Download "挪威语.zip"'>挪威语.zip</a><span>10:00</span></div>
<div data-id="photo1"><button data-testid="image-thumb" aria-label="Open picture" onclick="document.querySelector('#viewer').hidden=false"><img src="/png" width="40"></button><span>10:01</span></div>
<div data-id="link1"><span data-pre-plain-text="[10:02, 9/12/2026] Test: ">Link</span><a href="https://docs.example.test/sheet?gid=42#gid=42">Sheet</a></div>
</div><footer><div contenteditable="true" role="textbox" oninput="document.querySelector('#send').hidden=!this.innerText"></div><button id="send" aria-label="Send" hidden onclick="send()">Send</button></footer></div>
<input type="file" accept="*" multiple onchange="previewFiles(Array.from(this.files))"><div id="preview"></div>
<div id="viewer" role="dialog" hidden><button aria-label="Download" onclick="let a=document.createElement('a');a.href='/png';a.download='picture.png';a.click()">Download</button><button aria-label="Close" onclick="document.querySelector('#viewer').hidden=true">Close</button></div>
<script>window.sent=0;
function previewFiles(files){const preview=document.querySelector('#preview');preview.replaceChildren();for(const file of files){const tab=document.createElement('div');tab.setAttribute('role','tab');tab.setAttribute('aria-label','Open document, '+file.name+', item 1');tab.textContent=file.name;preview.append(tab);}const s=document.querySelector('#send');s.hidden=false;s.setAttribute('aria-label','Send '+files.length+' selected');}
function send(){window.sent++;let e=document.createElement('div');e.dataset.id='out-'+window.sent;e.className='message-out';e.innerHTML='<span data-icon="tail-out"></span>';const text=document.querySelector('footer [contenteditable]').innerText;const body=document.createElement('span');body.dataset.testid=text?'selectable-text':'document-thumb';body.textContent=text||document.querySelector('#preview').textContent;e.append(body);document.querySelector('[data-testid="conversation-panel-messages"]').append(e);document.querySelector('footer [contenteditable]').innerText='';document.querySelector('#preview').textContent='';document.querySelector('#send').hidden=true;}</script>`;

before(async()=>{
  server=createServer((req,res)=>{
    if(req.url==='/zip'){res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':"attachment; filename*=UTF-8''%E6%8C%AA%E5%A8%81%E8%AF%AD.zip"});res.end(zip);}
    else if(req.url==='/png'){res.writeHead(200,{'Content-Type':'image/png'});res.end(png);}
    else if(req.url==='/slow-download'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="slow.bin"','Content-Length':'1000000'});res.write('incomplete local payload');req.on('close',()=>res.destroy());}
    else if(req.url?.startsWith('/linked?')){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Local linked page</title><p>Observed link destination</p>');}
    else {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}/`;
  const {chromium}=await playwrightModule(),{chrome}=await checkRequirements();
  browser=await chromium.launch({channel:'chrome',executablePath:chrome,headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));assert.equal(path.dirname(root),path.resolve(scratch));await fs.rm(root,{recursive:true,force:true});});
async function fixture(){const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();await page.goto(url);return {page,close:()=>context.close(),run:(op,args={})=>browserAction(page,op,{fixture:true,chat:'Team A',...args})};}
async function selectedFileBytes(page){return Buffer.from(await page.locator('input[type="file"]').evaluate(async input=>Array.from(new Uint8Array(await input.files[0].arrayBuffer()))));}

test('Exact chat identity and duplicates are checked before actions',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.run('chat',{name:'Duplicate'}),{code:'AMBIGUOUS_CHAT'});
    await assert.rejects(f.run('compose',{chat:'Someone else',text:'wrong'}),{code:'WRONG_CHAT'});
    assert.equal(await f.page.locator('footer [contenteditable]').innerText(),'');
    await f.page.locator('#main header').evaluate(e=>e.textContent='Team B');
    assert.equal((await f.run('chat',{name:'Team A'})).chat,'Team A');
    assert.equal(await f.page.locator('#main header').innerText(),'Team A');
  }finally{await f.close();}
});

test('Messages disclose partial coverage and preserve full links and raw metadata',async()=>{
  const f=await fixture();try{
    const r=await f.run('messages');assert.equal(r.complete,false);assert.equal(r.messages.length,3);
    assert.equal(r.messages[0].rawTimestampAndSender,'[10:00, 9/12/2026] Test: ');
    assert.equal(r.messages[1].attachments[0].kind,'image');
    const links=await f.run('links');assert.equal(links.links.at(-1).url,'https://docs.example.test/sheet?gid=42#gid=42');
  }finally{await f.close();}
});

test('Download document and photo original bytes, close viewer, then verify repeat skip',async()=>{
  const f=await fixture(),out=await fs.mkdtemp(path.join(root,'downloads-'));try{
    for(const [message,expected] of [['doc1',zip],['photo1',png]]){
      const source={chat:'Team A',messageId:message,item:0};let calls=0;
      const dl=savePath=>{calls++;return f.run('download',{message,savePath,timeout:4000});};
      const file=await saveDownload(out,source,dl);assert.deepEqual(await fs.readFile(file.path),expected);
      assert.equal((await saveDownload(out,source,dl)).status,'skipped_verified');assert.equal(calls,1);
    }
    assert.equal(await f.page.locator('#viewer').isVisible(),false);
  }finally{await f.close();}
});

test('Compose preserves existing drafts, does not send; explicit send creates outgoing bubble',async()=>{
  const f=await fixture();try{
    const r=await f.run('compose',{text:'A harmless local test'});assert.equal(r.sent,false);
    assert.equal(await f.page.evaluate(()=>window.sent),0);
    await assert.rejects(f.run('compose',{text:'overwrite'}),{code:'EXISTING_DRAFT'});
    await assert.rejects(f.run('send'),{code:'SEND_AUTHORIZATION'});
    assert.equal(await f.page.evaluate(()=>window.sent),0);
    assert.equal((await f.run('send',{authorized:true,expected:{kind:'text',chat:'Team A',text:'A harmless local test'}})).status,'outgoing_message_observed');
    assert.equal(await f.page.evaluate(()=>window.sent),1);
  }finally{await f.close();}
});

test('Upload stages original bytes without sending',async()=>{
  const f=await fixture(),dir=await fs.mkdtemp(path.join(root,'upload-')),file=path.join(dir,'local.txt');await fs.writeFile(file,'local test');try{
    await f.run('upload',{files:[file]});
    assert.deepEqual(await selectedFileBytes(f.page),Buffer.from('local test'));
    assert.equal((await f.run('verify-upload',{files:[file]})).sent,false);
    assert.equal(await f.page.locator('#preview').innerText(),'local.txt');
    assert.equal(await f.page.evaluate(()=>window.sent),0);
    assert.equal((await f.run('send',{authorized:true,expected:{kind:'files',chat:'Team A',names:['local.txt']}})).status,'outgoing_message_observed');
  }finally{await f.close();}
});

test('Aria-label-only download controls are discovered',async()=>{
  const f=await fixture();try{
    await f.page.locator('[data-id="doc1"]').evaluate(e=>{e.innerHTML='<button aria-label="Download attachment">Get file</button>';});
    const r=await f.run('messages');assert.equal(r.messages[0].attachments[0].kind,'document');
  }finally{await f.close();}
});

test('Changed drafts and existing attachment previews are not overwritten or sent',async()=>{
  const f=await fixture();try{
    await f.run('compose',{text:'Original'});
    await assert.rejects(f.run('send',{authorized:true,expected:{kind:'text',chat:'Team A',text:'Different'}}),{code:'DRAFT_CHANGED'});
    assert.equal(await f.page.evaluate(()=>window.sent),0);
    await f.page.locator('#send').evaluate(e=>e.setAttribute('aria-label','Send 1 selected'));
    await assert.rejects(f.run('upload',{files:['ignored.txt']}),{code:'EXISTING_PREVIEW'});
  }finally{await f.close();}
});

test('An emoji-only draft is preserved when preparing text or files',async()=>{
  const f=await fixture();try{
    await f.page.locator('footer [contenteditable]').evaluate(e=>e.innerHTML='<img alt="✅">');
    await assert.rejects(f.run('compose',{text:'Overwrite'}),{code:'EXISTING_DRAFT'});
    await assert.rejects(f.run('upload',{files:['unused.txt']}),{code:'EXISTING_DRAFT'});
    assert.equal(await f.page.locator('footer img').getAttribute('alt'),'✅');
  }finally{await f.close();}
});

test('A two-file send waits for both outgoing messages, including bubbles without tails',async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>{
      document.querySelector('#preview').innerHTML='<div role="tab" aria-label="Open document, a.txt, item 1 of 2"></div><div role="tab" aria-label="Open document, b.txt, item 2 of 2"></div>';
      for(const e of document.querySelectorAll('[role="tab"]')) {e.style.width='20px';e.style.height='20px';}
      const s=document.querySelector('#send');s.hidden=false;s.setAttribute('aria-label','Send 2 selected');
      window.send=()=>{window.sent++;for(const [i,name] of ['a.txt','b.txt'].entries())setTimeout(()=>{
        const e=document.createElement('div');e.dataset.id='file-out-'+i;e.innerHTML='<span data-testid="document-thumb">'+name+'</span><div data-testid="msg-meta"><span aria-label=" Read "></span></div>';document.querySelector('[data-testid="conversation-panel-messages"]').append(e);
      },i*500);s.hidden=true;};
    });
    const r=await f.run('send',{authorized:true,expected:{kind:'files',chat:'Team A',names:['a.txt','b.txt']}});
    assert.equal(r.messages.length,2);assert.ok(r.messages.every(m=>m.delivery==='read'));
    assert.equal(await f.page.evaluate(()=>window.sent),1);
  }finally{await f.close();}
});

test('An uncertain send is reported after exactly one click',async()=>{
  const f=await fixture();try{
    await f.run('compose',{text:'Uncertain test'});
    await f.page.evaluate(()=>{window.send=()=>{window.sent++;document.querySelector('#send').hidden=true;};});
    await assert.rejects(f.run('send',{authorized:true,expected:{kind:'text',chat:'Team A',text:'Uncertain test'}}),{code:'SEND_UNCERTAIN'});
    assert.equal(await f.page.evaluate(()=>window.sent),1);
  }finally{await f.close();}
});

test('Chat selection ignores identical words in another chat message preview',async()=>{
  const f=await fixture();try{
    await f.page.locator('#pane-side').evaluate(e=>{e.insertAdjacentHTML('beforeend','<div role="row"><button title="Another team">Another team</button><span>Team A</span></div>');});
    assert.equal((await f.run('chat',{name:'Team A'})).chat,'Team A');
  }finally{await f.close();}
});

test('Emoji text is preserved, quote attachments excluded, and refreshed history updates delivery',async()=>{
  const f=await fixture();try{
    await f.page.locator('[data-id="link1"]').evaluate(e=>{e.innerHTML='<blockquote data-testid="quoted-message"><a download="quoted.zip">Quoted file</a></blockquote><span data-testid="selectable-text">Hei <img alt="✅"><br>Linje to</span><div data-testid="msg-meta"><span aria-label="Sent"></span></div>';});
    const before=await f.run('messages',{contains:'✅'});
    assert.equal(before.messages[0].messageText,'Hei ✅\nLinje to');assert.equal(before.messages[0].attachments.length,0);
    await f.page.evaluate(()=>setTimeout(()=>document.querySelector('[aria-label="Sent"]').setAttribute('aria-label','Read'),200));
    const after=await f.run('messages',{older:1});assert.equal(after.messages.at(-1).delivery,'read');
  }finally{await f.close();}
});

test('Historical filenames cannot validate a changed attachment preview or a text send',async()=>{
  const f=await fixture();try{
    await f.run('compose',{text:'Expected'});
    await f.page.evaluate(()=>{previewFiles([{name:'wrong.txt'}]);document.querySelector('[data-id="doc1"]').insertAdjacentHTML('beforeend','<span>right.txt</span>');});
    await assert.rejects(f.run('verify-upload',{files:['right.txt'],quick:true}),{code:'NO_PREVIEW'});
    await assert.rejects(f.run('send',{authorized:true,expected:{kind:'files',chat:'Team A',names:['right.txt']}}),{code:'DRAFT_CHANGED'});
    await assert.rejects(f.run('send',{authorized:true,expected:{kind:'text',chat:'Team A',text:'Expected'}}),{code:'DRAFT_CHANGED'});
    await assert.rejects(f.run('send',{authorized:true}),{code:'DRAFT_MISMATCH'});
    assert.equal(await f.page.evaluate(()=>window.sent),0);
  }finally{await f.close();}
});

test('Send confirmation ignores unrelated text and waits for the exact text including emoji',async()=>{
  const f=await fixture();try{
    const text='Hei ✅\nLinje to';await f.run('compose',{text});
    await f.page.evaluate(()=>{window.send=()=>{window.sent++;const list=document.querySelector('[data-testid="conversation-panel-messages"]');list.insertAdjacentHTML('beforeend','<div data-id="unrelated" class="message-out"><span data-testid="selectable-text">Different message</span></div>');document.querySelector('#send').hidden=true;setTimeout(()=>list.insertAdjacentHTML('beforeend','<div data-id="exact-text" class="message-out"><span data-testid="selectable-text">Hei <img alt="✅"><br>Linje to</span></div>'),800);};});
    const r=await f.run('send',{authorized:true,expected:{kind:'text',chat:'Team A',text}});
    assert.deepEqual(r.messages.map(m=>m.messageId),['exact-text']);assert.equal(await f.page.evaluate(()=>window.sent),1);
  }finally{await f.close();}
});

test('A batch confirmation requires each exact filename, not multiple copies of one file',async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>{
      previewFiles([{name:'a.txt'},{name:'b.txt'}]);window.send=()=>{
        window.sent++;const list=document.querySelector('[data-testid="conversation-panel-messages"]');
        for(const id of ['one','duplicate'])list.insertAdjacentHTML('beforeend','<div data-id="'+id+'" class="message-out"><span data-testid="document-thumb">a.txt</span></div>');
        setTimeout(()=>list.insertAdjacentHTML('beforeend','<div data-id="second-file" class="message-out"><span data-testid="document-thumb">b.txt</span></div>'),800);
        document.querySelector('#send').hidden=true;
      };
    });
    const r=await f.run('send',{authorized:true,expected:{kind:'files',chat:'Team A',names:['a.txt','b.txt']}});
    assert.deepEqual(r.messages.map(m=>m.messageId),['one','second-file']);
  }finally{await f.close();}
});

test('A delayed result can be checked without sending again',async()=>{
  const f=await fixture();try{
    const expected={kind:'text',chat:'Team A',text:'Check result'};
    await f.run('compose',{text:expected.text});
    const {before,confirmation}=await f.run('prepare-send',{authorized:true,expected});
    expected.attempt={at:new Date().toISOString(),before,confirmation};
    assert.equal((await f.run('send-check',{expected,before,confirmation})).status,'send_unresolved');
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(e=>e.insertAdjacentHTML('beforeend','<div data-id="delayed" class="message-out"><span data-testid="selectable-text">Check result</span></div>'));
    assert.equal((await f.run('send-check',{expected,before,confirmation})).messages[0].messageId,'delayed');assert.equal(await f.page.evaluate(()=>window.sent),0);
  }finally{await f.close();}
});

test('Preview validation compares the complete filename and preserves legitimate commas',async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>previewFiles([{name:'draft, report[1].pdf'}]));
    const wrong={kind:'files',chat:'Team A',names:['report[1].pdf']};
    await assert.rejects(f.run('verify-upload',{files:wrong.names,quick:true}),{code:'NO_PREVIEW'});
    await assert.rejects(f.run('prepare-send',{authorized:true,expected:wrong}),{code:'DRAFT_CHANGED'});
    await assert.rejects(f.run('send',{authorized:true,expected:wrong}),{code:'DRAFT_CHANGED'});
    assert.equal(await f.page.evaluate(()=>window.sent),0);
    const expected={kind:'files',chat:'Team A',names:['draft, report[1].pdf']};
    assert.equal((await f.run('verify-upload',{files:expected.names,quick:true})).status,'files_staged');
    assert.equal((await f.run('send',{authorized:true,expected})).status,'outgoing_message_observed');
    assert.equal(await f.page.evaluate(()=>window.sent),1);
  }finally{await f.close();}
});

test('A filename cannot match only the preview action label or differ in case',async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>previewFiles([{name:'report.pdf'}]));
    for(const name of ['Open document, report.pdf, item 1','REPORT.pdf']){
      await assert.rejects(f.run('verify-upload',{files:[name],quick:true}),{code:'NO_PREVIEW'});
      await assert.rejects(f.run('send',{authorized:true,expected:{kind:'files',chat:'Team A',names:[name]}}),{code:'DRAFT_CHANGED'});
    }
    assert.equal(await f.page.evaluate(()=>window.sent),0);
  }finally{await f.close();}
});

test('Raw preview filenames distinguish leading and repeated internal whitespace before Send',async()=>{
  const f=await fixture();try{
    for(const [actual,substitute] of [[' report.pdf','report.pdf'],['report  final.pdf','report final.pdf'],['report\u00a0final.pdf','report final.pdf']]){
      await f.page.evaluate(name=>previewFiles([{name}]),actual);
      const expected={kind:'files',chat:'Team A',names:[substitute]};
      await assert.rejects(f.run('verify-upload',{files:expected.names,quick:true}),{code:'NO_PREVIEW'});
      await assert.rejects(f.run('prepare-send',{authorized:true,expected}),{code:'DRAFT_CHANGED'});
      await assert.rejects(f.run('send',{authorized:true,expected}),{code:'DRAFT_CHANGED'});
      assert.equal(await f.page.evaluate(()=>window.sent),0);
      assert.equal((await f.run('verify-upload',{files:[actual],quick:true})).status,'files_staged');
      assert.ok((await f.run('prepare-send',{authorized:true,expected:{...expected,names:[actual]}})).before.length>0);
    }
  }finally{await f.close();}
});

test('Raw filename verification waits for a delayed preview and then sends the matching file',async()=>{
  const f=await fixture();try{
    const name='draft, report[1].pdf';
    await f.page.evaluate(name=>setTimeout(()=>previewFiles([{name}]),200),name);
    assert.equal((await f.run('verify-upload',{files:[name]})).status,'files_staged');
    assert.equal((await f.run('send',{authorized:true,expected:{kind:'files',chat:'Team A',names:[name]}})).status,'outgoing_message_observed');
    assert.equal(await f.page.evaluate(()=>window.sent),1);
  }finally{await f.close();}
});

test('File sends reject added text, emoji, input and hidden captions before clicking Send',async()=>{
  const f=await fixture();try{
    const expected={kind:'files',chat:'Team A',names:['report.pdf']};
    for(const kind of ['text','emoji','input','hidden']){
      await f.page.evaluate(kind=>{
        previewFiles([{name:'report.pdf'}]);
        const input=document.createElement(kind==='input'?'input':'div');input.id='caption';
        if(kind==='input'){input.type='text';input.value='Unrequested caption';}
        else{input.contentEditable='true';input.setAttribute('role','textbox');input.innerHTML=kind==='emoji'?'<img alt="✅">':'Unrequested caption';}
        if(kind==='hidden')input.hidden=true;
        document.querySelector('#preview').append(input);
      },kind);
      await assert.rejects(f.run('verify-upload',{files:expected.names,quick:true}),{code:'DRAFT_CHANGED'});
      await assert.rejects(f.run('prepare-send',{authorized:true,expected}),{code:'DRAFT_CHANGED'});
      await assert.rejects(f.run('send',{authorized:true,expected}),{code:'DRAFT_CHANGED'});
      assert.equal(await f.page.evaluate(()=>window.sent),0);
    }
    await f.page.evaluate(()=>{
      document.querySelector('#caption').remove();
      const caption=document.createElement('div');caption.contentEditable='true';caption.setAttribute('role','textbox');caption.innerHTML='<br>';document.querySelector('#preview').append(caption);
    });
    await f.page.locator('#side input').fill('Team A');
    assert.equal((await f.run('verify-upload',{files:expected.names,quick:true})).status,'files_staged');
    assert.equal((await f.run('send',{authorized:true,expected})).status,'outgoing_message_observed');
    assert.equal(await f.page.evaluate(()=>window.sent),1);
  }finally{await f.close();}
});

test('Historical matching rows cannot confirm an attempt, including after its anchor is unloaded',async()=>{
  const f=await fixture();try{
    const expected={kind:'text',chat:'Team A',text:'Repeated message'};
    await f.run('compose',{text:expected.text});
    const {before,confirmation}=await f.run('prepare-send',{authorized:true,expected});
    assert.equal(confirmation.atLatest,true);assert.equal(confirmation.anchorId,'link1');
    expected.attempt={at:'2026-09-12T12:00:00.000Z',before,confirmation};
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(e=>e.insertAdjacentHTML('afterbegin','<div data-id="old-history" class="message-out"><span data-pre-plain-text="[10:00, 1/1/2020] Test: "></span><span data-testid="selectable-text">Repeated message</span></div>'));
    assert.equal((await f.run('send-check',{expected,before,confirmation})).status,'send_unresolved');
    await f.page.locator('[data-id="link1"]').evaluate(e=>e.remove());
    assert.equal((await f.run('send-check',{expected,before,confirmation})).status,'send_unresolved');
    assert.equal(await f.page.evaluate(()=>window.sent),0);
  }finally{await f.close();}
});

test('Legacy and incomplete chronological evidence cannot confirm a matching message',async()=>{
  const f=await fixture();try{
    const expected={kind:'text',chat:'Team A',text:'Repeated message'},before=(await f.run('messages')).messages.map(message=>message.id);
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(e=>e.insertAdjacentHTML('beforeend','<div data-id="unknown-age" class="message-out"><span data-testid="selectable-text">Repeated message</span></div>'));
    for(const confirmation of [undefined,{version:1,atLatest:false,anchorId:'link1'},{version:1,atLatest:true,anchorId:null},{version:1,atLatest:true,anchorId:'not-in-baseline'}]){
      assert.equal((await f.run('send-check',{expected,before,confirmation})).status,'send_unresolved');
    }
    assert.equal(await f.page.evaluate(()=>window.sent),0);
  }finally{await f.close();}
});

test('Preparing from older loaded history does not claim a latest-edge baseline',async()=>{
  const f=await fixture();try{
    const expected={kind:'text',chat:'Team A',text:'Repeated message'};
    await f.run('compose',{text:expected.text});
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(e=>{
      e.insertAdjacentHTML('beforeend','<div style="height:1000px"></div>');e.scrollTop=0;
    });
    const {before,confirmation}=await f.run('prepare-send',{authorized:true,expected});
    assert.equal(confirmation.atLatest,false);
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(e=>e.insertAdjacentHTML('beforeend','<div data-id="unknown-age" class="message-out"><span data-testid="selectable-text">Repeated message</span></div>'));
    assert.equal((await f.run('send-check',{expected,before,confirmation})).status,'send_unresolved');
  }finally{await f.close();}
});

test('Send preserves the persisted baseline and stops before clicking if its latest anchor changes',async()=>{
  const f=await fixture();try{
    const expected={kind:'text',chat:'Team A',text:'Prepared text'};
    await f.run('compose',{text:expected.text});
    expected.attempt={at:new Date().toISOString(),...await f.run('prepare-send',{authorized:true,expected})};
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(e=>e.insertAdjacentHTML('beforeend','<div data-id="intervening"><span data-testid="selectable-text">Another message</span></div>'));
    await assert.rejects(f.run('send',{authorized:true,expected}),{code:'DRAFT_CHANGED'});
    assert.equal(await f.page.evaluate(()=>window.sent),0);
    await f.page.locator('[data-id="intervening"]').evaluate(e=>e.remove());
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(e=>e.insertAdjacentHTML('afterbegin','<div data-id="older" class="message-out"><span data-testid="selectable-text">Prepared text</span></div>'));
    const result=await f.run('send',{authorized:true,expected});
    assert.equal(result.status,'outgoing_message_observed');assert.deepEqual(result.messages.map(message=>message.messageId),['out-1']);
    assert.equal(await f.page.evaluate(()=>window.sent),1);
  }finally{await f.close();}
});

test('Chat search updates the loaded result set and reports a missing exact match',async()=>{
  const f=await fixture();try{
    await f.page.locator('#side input').evaluate(input=>{
      const rows=Array.from(document.querySelectorAll('#pane-side [role="row"]'));
      input.oninput=()=>{const query=input.value;setTimeout(()=>document.querySelector('#pane-side').replaceChildren(...rows.filter(row=>row.textContent.includes(query))),100);};
    });
    const duplicates=await f.run('chats',{query:'Duplicate'});
    assert.equal(await f.page.locator('#side input').inputValue(),'Duplicate');
    assert.deepEqual(duplicates.chats.map(chat=>chat.title),['Duplicate','Duplicate']);
    assert.equal(duplicates.coverage,'loaded_search_results_only');
    assert.deepEqual((await f.run('chats',{query:'Team A'})).chats.map(chat=>chat.title),['Team A']);
    await assert.rejects(f.run('chat',{name:'Missing team'}),{code:'CHAT_NOT_FOUND'});
    assert.equal(await f.page.locator('#main header').innerText(),'Team A');
  }finally{await f.close();}
});

test('History scrolling loads older rows through the known and fallback scrollers',async()=>{
  for(const fallback of [false,true]){
    const f=await fixture();try{
      await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(async(list,fallback)=>{
        list.id='history';if(fallback)list.removeAttribute('data-testid');
        const spacer=document.createElement('div');spacer.style.height='1200px';list.prepend(spacer);list.scrollTop=list.scrollHeight;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        list.addEventListener('scroll',()=>{if(list.scrollTop===0&&!document.querySelector('[data-id="older"]'))list.insertAdjacentHTML('afterbegin','<div data-id="older"><span data-testid="selectable-text">Older message</span></div>');});
      },fallback);
      assert.ok(await f.page.locator('#history').evaluate(list=>list.scrollTop>0));
      const result=await f.run('messages',{older:1});
      assert.deepEqual(result.messages.map(message=>message.id),['older','doc1','photo1','link1']);
      assert.equal(result.scrolls,1);assert.equal(result.totalCollected,4);assert.equal(result.complete,false);
      assert.equal(await f.page.locator('#history').evaluate(list=>list.scrollTop),0);
    }finally{await f.close();}
  }
});

test('Message limits preserve latest order and report the collected total',async()=>{
  const f=await fixture();try{
    const result=await f.run('messages',{limit:2});
    assert.deepEqual(result.messages.map(message=>message.id),['photo1','link1']);
    assert.equal(result.totalCollected,3);assert.equal(result.complete,false);
    assert.deepEqual((await f.run('messages',{limit:1})).messages.map(message=>message.id),['link1']);
  }finally{await f.close();}
});

test('An incoming exact echo cannot confirm an outgoing send',async()=>{
  const f=await fixture();try{
    const expected={kind:'text',chat:'Team A',text:'An exact echo'};
    await f.run('compose',{text:expected.text});
    const baseline=await f.run('prepare-send',{authorized:true,expected});
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(list=>list.insertAdjacentHTML('beforeend','<div data-id="incoming-echo" class="message-in"><span data-testid="selectable-text">An exact echo</span></div>'));
    assert.equal((await f.run('send-check',{expected,...baseline})).status,'send_unresolved');
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(list=>list.insertAdjacentHTML('beforeend','<div data-id="outgoing-echo" class="message-out"><span data-testid="selectable-text">An exact echo</span></div>'));
    assert.deepEqual((await f.run('send-check',{expected,...baseline})).messages.map(message=>message.messageId),['outgoing-echo']);
    assert.equal(await f.page.evaluate(()=>window.sent),0);
  }finally{await f.close();}
});

test('A non-WhatsApp origin is rejected before reading or changing a draft',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.run('status',{fixture:false}),{code:'WRONG_ORIGIN'});
    await assert.rejects(f.run('compose',{fixture:false,text:'Must not be entered'}),{code:'WRONG_ORIGIN'});
    assert.equal(await f.page.locator('footer [contenteditable]').innerText(),'');
    assert.equal(await f.page.evaluate(()=>window.sent),0);
  }finally{await f.close();}
});

test('A chat change after one Send click leaves the attempt uncertain',async()=>{
  const f=await fixture();try{
    const expected={kind:'text',chat:'Team A',text:'Prepared outgoing'};await f.run('compose',{text:expected.text});
    await f.page.evaluate(()=>{window.send=()=>{window.sent++;document.querySelector('#main header').textContent='Team B';document.querySelector('[data-testid="conversation-panel-messages"]').insertAdjacentHTML('beforeend','<div data-id="during-chat-change" class="message-out"><span data-testid="selectable-text">Prepared outgoing</span></div>');};});
    await assert.rejects(f.run('send',{authorized:true,expected}),{code:'SEND_UNCERTAIN'});
    assert.equal(await f.page.evaluate(()=>window.sent),1);assert.equal(await f.page.locator('#main header').innerText(),'Team B');
  }finally{await f.close();}
});

test('A valid prepared draft still requires explicit Send authorization',async()=>{
  const f=await fixture();try{
    const expected={kind:'text',chat:'Team A',text:'Ready but not authorized'};
    await f.run('compose',{text:expected.text});
    await f.run('prepare-send',{authorized:true,expected});
    await assert.rejects(f.run('send',{expected}),{code:'SEND_AUTHORIZATION'});
    assert.equal(await f.page.evaluate(()=>window.sent),0);
    assert.equal(await f.page.locator('footer [contenteditable]').innerText(),expected.text);
    assert.equal((await f.run('send',{authorized:true,expected})).status,'outgoing_message_observed');
    assert.equal(await f.page.evaluate(()=>window.sent),1);
  }finally{await f.close();}
});

test('Connection reports login, loading and ready states and waits for readiness',async()=>{
  const f=await fixture();try{
    assert.equal((await f.run('status')).chat,'Team A');
    await f.page.setContent('<p>Scan to log in</p>');
    assert.deepEqual(await f.run('status'),{authenticated:false,chat:null,url:f.page.url(),state:'login_required'});
    await assert.rejects(f.run('compose',{text:'Unavailable'}),{code:'LOGIN_REQUIRED'});
    await f.page.setContent('<p>Loading application</p>');
    assert.deepEqual(await f.run('connection'),{authenticated:false,url:f.page.url(),state:'loading'});
    await f.page.evaluate(()=>setTimeout(()=>{const side=document.createElement('div');side.id='side';document.body.append(side);},200));
    assert.deepEqual(await f.run('connection',{wait:true}),{authenticated:true,url:f.page.url(),state:'ready'});
  }finally{await f.close();}
});

test('Open-link navigates an observed URL in a new tab and rejects an unobserved URL',async()=>{
  const f=await fixture();try{
    const observed=new URL('linked?item=42#details',url).href,unobserved=new URL('unobserved',url).href;
    await f.page.locator('[data-id="link1"] a').evaluate((link,href)=>link.href=href,observed);
    await assert.rejects(f.run('open-link',{url:unobserved}),{code:'LINK_NOT_OBSERVED'});
    assert.equal(f.page.context().pages().length,1);
    assert.deepEqual(await f.run('open-link',{url:observed}),{url:observed,opened:true});
    const pages=f.page.context().pages();assert.equal(pages.length,2);
    assert.equal(pages[1].url(),observed);assert.equal(await pages[1].title(),'Local linked page');
    assert.equal(f.page.url(),url);
  }finally{await f.close();}
});

test('Upload opens the attachment menu and stages original bytes through a real file chooser',async()=>{
  const f=await fixture(),file=path.join(root,'chooser-original.txt');await fs.writeFile(file,'Original through chooser');try{
    await f.page.evaluate(()=>{
      document.querySelector('input[type="file"]').setAttribute('accept','text/plain');window.attachClicks=0;window.documentClicks=0;
      const menu=document.createElement('button');menu.setAttribute('role','menuitem');menu.textContent='Document';menu.hidden=true;
      menu.onclick=()=>{window.documentClicks++;document.querySelector('input[type="file"]').click();};document.body.append(menu);
      const attach=document.createElement('button');attach.setAttribute('aria-label','Attach');attach.textContent='Attach';attach.onclick=()=>{window.attachClicks++;menu.hidden=false;};document.querySelector('#main footer').append(attach);
    });
    const pending=f.page.waitForEvent('filechooser',{timeout:5000});pending.catch(()=>{});
    assert.deepEqual(await f.run('upload',{files:[file]}),{fileChooserPending:true});
    const chooser=await pending;await chooser.setFiles([file]);
    assert.deepEqual(await selectedFileBytes(f.page),Buffer.from('Original through chooser'));
    assert.equal((await f.run('verify-upload',{files:[file]})).status,'files_staged');
    assert.deepEqual(await f.page.evaluate(()=>[window.attachClicks,window.documentClicks,window.sent]),[1,1,0]);
  }finally{await f.close();}
});

test('Missing download events are reported after one activation without saving a file',async()=>{
  const f=await fixture(),savePath=path.join(root,'missing-download.zip');try{
    await f.page.locator('[data-id="doc1"]').evaluate(row=>{window.downloadClicks=0;row.innerHTML='<button aria-label="Download attachment">Download</button>';row.querySelector('button').onclick=()=>window.downloadClicks++;});
    await assert.rejects(f.run('download',{message:'doc1',savePath,timeout:250}),{code:'DOWNLOAD_UNCONFIRMED'});
    assert.equal(await f.page.evaluate(()=>window.downloadClicks),1);
    await assert.rejects(fs.stat(savePath),{code:'ENOENT'});
  }finally{await f.close();}
});

test('A canceled browser download is reported as failed and leaves no saved file',async()=>{
  const f=await fixture(),savePath=path.join(root,'canceled-download.bin');try{
    await f.page.locator('[data-id="doc1"] a').evaluate(link=>{link.href='/slow-download';link.download='slow.bin';});
    const cancellation=f.page.waitForEvent('download',{timeout:5000}).then(download=>download.cancel());cancellation.catch(()=>{});
    await assert.rejects(f.run('download',{message:'doc1',savePath,timeout:5000}),{code:'DOWNLOAD_FAILED'});
    await cancellation;await assert.rejects(fs.stat(savePath),{code:'ENOENT'});
  }finally{await f.close();}
});

test('Ambiguous media download controls are not activated and the viewer is closed',async()=>{
  const f=await fixture(),savePath=path.join(root,'ambiguous-download.png');try{
    await f.page.locator('#viewer').evaluate(viewer=>{
      window.downloadClicks=0;const existing=viewer.querySelector('[aria-label="Download"]');existing.onclick=()=>window.downloadClicks++;
      const extra=existing.cloneNode(true);extra.onclick=()=>window.downloadClicks++;viewer.append(extra);
    });
    await assert.rejects(f.run('download',{message:'photo1',savePath,timeout:5000}),{code:'DOWNLOAD_AMBIGUOUS'});
    assert.equal(await f.page.evaluate(()=>window.downloadClicks),0);
    assert.equal(await f.page.locator('#viewer').isVisible(),false);await assert.rejects(fs.stat(savePath),{code:'ENOENT'});
  }finally{await f.close();}
});

test('File sends preserve significant filename whitespace through outgoing confirmation',async()=>{
  for(const name of [' report.pdf','report  final.pdf','report\u00a0final.pdf']){
    const f=await fixture();try{
      await f.page.evaluate(name=>previewFiles([{name}]),name);
      assert.equal((await f.run('verify-upload',{files:[name],quick:true})).status,'files_staged');
      const result=await f.run('send',{authorized:true,expected:{kind:'files',chat:'Team A',names:[name]}});
      assert.equal(result.status,'outgoing_message_observed');assert.equal(await f.page.evaluate(()=>window.sent),1);
      assert.deepEqual((await f.run('messages')).messages.at(-1).documentNames,[name]);
    }finally{await f.close();}
  }
});

test('Send checks require exact raw filenames and ignore hidden filename text',async()=>{
  const f=await fixture();try{
    const expected={kind:'files',chat:'Team A',names:['report.pdf']};
    await f.page.evaluate(()=>previewFiles([{name:'report.pdf'}]));
    const baseline=await f.run('prepare-send',{authorized:true,expected});
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(list=>{
      list.insertAdjacentHTML('beforeend','<div data-id="whitespace-impostor" class="message-out"><span data-testid="document-thumb"> report.pdf</span></div><div data-id="hidden-name" class="message-out"><span data-testid="document-thumb"><span hidden>report.pdf<br></span>other.pdf</span></div>');
    });
    assert.equal((await f.run('send-check',{expected,...baseline})).status,'send_unresolved');
    assert.deepEqual((await f.run('messages')).messages.at(-1).documentNames,['other.pdf']);
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(list=>list.insertAdjacentHTML('beforeend','<div data-id="exact-name" class="message-out"><span data-testid="document-thumb">report.pdf</span></div>'));
    const confirmed=await f.run('send-check',{expected,...baseline});assert.equal(confirmed.status,'outgoing_message_observed');
    assert.deepEqual(confirmed.messages.map(message=>message.messageId),['exact-name']);
    assert.equal(await f.page.evaluate(()=>window.sent),0);
  }finally{await f.close();}
});
