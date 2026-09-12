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
    else {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}/`;
  const {chromium}=await playwrightModule(),{chrome}=await checkRequirements();
  browser=await chromium.launch({channel:'chrome',executablePath:chrome,headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));assert.equal(path.dirname(root),path.resolve(scratch));await fs.rm(root,{recursive:true,force:true});});
async function fixture(){const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();await page.goto(url);return {page,close:()=>context.close(),run:(op,args={})=>browserAction(page,op,{fixture:true,chat:'Team A',...args})};}

test('Exact chat identity and duplicates are checked before actions',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.run('chat',{name:'Duplicate'}),{code:'AMBIGUOUS_CHAT'});
    await assert.rejects(f.run('compose',{chat:'Someone else',text:'wrong'}),{code:'WRONG_CHAT'});
    assert.equal(await f.page.locator('footer [contenteditable]').innerText(),'');
    assert.equal((await f.run('chat',{name:'Team A'})).chat,'Team A');
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

test('Upload stages original file without sending',async()=>{
  const f=await fixture(),dir=await fs.mkdtemp(path.join(root,'upload-')),file=path.join(dir,'local.txt');await fs.writeFile(file,'local test');try{
    await f.run('upload',{files:[file]});
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
    const expected={kind:'text',chat:'Team A',text:'Check result'},before=(await f.run('messages')).messages.map(m=>m.id);
    assert.equal((await f.run('send-check',{expected,before})).status,'send_unresolved');
    await f.page.locator('[data-testid="conversation-panel-messages"]').evaluate(e=>e.insertAdjacentHTML('beforeend','<div data-id="delayed" class="message-out"><span data-testid="selectable-text">Check result</span></div>'));
    assert.equal((await f.run('send-check',{expected,before})).messages[0].messageId,'delayed');assert.equal(await f.page.evaluate(()=>window.sent),0);
  }finally{await f.close();}
});
