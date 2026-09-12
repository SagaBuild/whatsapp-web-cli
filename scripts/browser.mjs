// This function is serialized into Playwright CLI. Keep it self-contained.
// It reads rendered DOM only; it never accesses WhatsApp's internal app store.
export async function browserAction(page, op, a) {
  const error=(code,message,details)=>{throw Object.assign(new Error(message),{code,details});};
  const main=page.locator('#main');
  const sendPattern=/^(send(?: \d+ selected)?|send message|send melding|send \d+ valgte|senden|envoyer|enviar)$/i;
  const chatTitle=async()=>{
    const header=main.locator('header');
    if(!await header.count()) return null;
    return (await header.innerText()).split('\n').map(s=>s.trim()).find(Boolean)||null;
  };
  const currentUrl=page.url();
  if(!/^https:\/\/web\.whatsapp\.com(?:\/|$)/.test(currentUrl) && !(a.fixture && /^http:\/\/127\.0\.0\.1:\d+\//.test(currentUrl))) error('WRONG_ORIGIN','Current tab is not WhatsApp Web. Select the WhatsApp tab first.');
  let ready=await page.locator('#pane-side, #side').count()>0;
  if(op==='status'||op==='connection') {
    if(a.wait)for(let i=0;i<20&&!ready;i++){await page.waitForTimeout(400);ready=await page.locator('#pane-side, #side').count()>0;}
    const login=await page.getByText(/^(scan to log in|skann for å logge inn)$/i).count()>0;
    return {authenticated:ready,...(op==='status'?{chat:await chatTitle()}:{}),url:page.url(),state:ready?'ready':login?'login_required':'loading'};
  }
  if(!ready) error('LOGIN_REQUIRED','WhatsApp is logged out or still loading. Use open; link this profile only if WhatsApp displays a login screen.');
  const guard=async()=>{
    if(!a.chat) error('CHAT_REQUIRED','Supply --chat with the exact observed chat title.');
    const actual=await chatTitle();
    if(actual!==a.chat) error('WRONG_CHAT','The open chat does not match the requested chat.',{expected:a.chat,actual});
  };
  const search=async(query)=>{
    const input=page.locator('#side input[role="textbox"], #side [contenteditable="true"][role="textbox"]');
    if(await input.count()!==1) error('SEARCH_CONTROL','Could not identify one chat search input. Use ui snapshot to inspect.');
    await input.fill(query);
    await page.waitForTimeout(700);
  };
  const listChats=async()=>page.locator('#pane-side [role="row"]').evaluateAll(rows=>rows.map((row,index)=>{
    const titles=Array.from(row.querySelectorAll('[title]')).map(e=>e.getAttribute('title')).filter(Boolean);
    return {index,title:titles[0]||null};
  }).filter(r=>r.title));
  if(op==='chats') {
    if(a.query!==undefined) await search(a.query);
    return {chats:await listChats(),coverage:'loaded_search_results_only'};
  }
  if(op==='chat') {
    if(!a.name) error('CHAT_REQUIRED','Supply an exact chat name.');
    await search(a.name);
    const matches=(await listChats()).filter(r=>r.title===a.name);
    const count=matches.length;
    if(count!==1) error(count?'AMBIGUOUS_CHAT':'CHAT_NOT_FOUND','Expected one exact chat match.',{name:a.name,count});
    await page.locator('#pane-side [role="row"]').nth(matches[0].index).locator('[title]').first().click();
    for(let i=0;i<20 && await chatTitle()!==a.name;i++) await page.waitForTimeout(150);
    if(await chatTitle()!==a.name) error('CHAT_NOT_OPEN','Chat header did not confirm the requested title.');
    await page.waitForTimeout(600);
    return {chat:await chatTitle()};
  }
  if(op==='guard') { await guard(); return {chat:a.chat}; }
  await guard();

  function inspectRow(el) {
    const quoteSelector='[data-testid="quoted-message"],[data-testid="quoted-message-text"],[data-testid="quoted-message-container"],blockquote';
    const own=node=>!node.closest(quoteSelector);
    const buttons=Array.from(el.querySelectorAll('button,[role="button"],a[download]'));
    const attachments=[];
    for(let i=0;i<buttons.length;i++) {
      const b=buttons[i], title=b.getAttribute('title')||'', label=b.getAttribute('aria-label')||'';
      if(!own(b))continue;
      const icon=b.querySelector('[data-icon]')?.getAttribute('data-icon')||'';
      const download=b.hasAttribute('download')||/^(download|last ned|herunterladen|télécharger|descargar|scarica|baixar)/i.test((title+' '+label).trim())||/^document-/.test(icon);
      const photo=/^(open (photo|image|picture)|åpne bilde|open video|åpne video)/i.test(label)||b.matches('[data-testid="image-thumb"]')||b.querySelector('[data-testid="image-thumb"]');
      if(!download&&!photo) continue;
      const kind=photo?(/video/i.test(label)?'video':'image'):'document';
      const quoted=title.match(/[«“"](.+)[»”"]/);
      const filename=b.getAttribute('download')||quoted?.[1]||null;
      attachments.push({item:attachments.length,kind,filename,label:label||title,buttonIndex:i});
    }
    const pre=Array.from(el.querySelectorAll('[data-pre-plain-text]')).find(own)?.getAttribute('data-pre-plain-text')||null;
    const deliveryLabels=Array.from(el.querySelectorAll('[data-testid="msg-meta"] [aria-label]')).filter(own).map(e=>e.getAttribute('aria-label').trim());
    const rawDelivery=deliveryLabels.find(v=>/^(read|lest|delivered|levert|sent|sendt|pending|venter)$/i.test(v))||null;
    const delivery=rawDelivery ? (/^(read|lest)$/i.test(rawDelivery)?'read':/^(delivered|levert)$/i.test(rawDelivery)?'delivered':/^(sent|sendt)$/i.test(rawDelivery)?'sent':'pending') : null;
    const outgoing=!!rawDelivery||!!el.querySelector('[data-icon="tail-out"],[data-testid="tail-out"]')||el.matches('.message-out')||!!el.querySelector('.message-out')||!!el.closest('.message-out');
    const body=Array.from(el.querySelectorAll('span[data-testid="selectable-text"],span.selectable-text')).find(own)||el;
    const copy=body.cloneNode(true);
    for(const node of copy.querySelectorAll(quoteSelector+', [data-testid="msg-meta"], [data-icon], [data-testid="document-thumb"]'))node.remove();
    const plain=node=>{
      if(node.nodeType===3)return node.textContent;
      if(node.nodeName==='IMG')return node.getAttribute('alt')||'';
      if(node.nodeName==='BR')return '\n';
      let text='';
      for(const child of node.childNodes){
        const block=/^(DIV|P)$/.test(child.nodeName);
        if(block&&text&&!text.endsWith('\n'))text+='\n';
        text+=plain(child);
        if(block&&child.nextSibling&&!text.endsWith('\n'))text+='\n';
      }
      return text;
    };
    const messageText=plain(copy).replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').trim();
    const documentNames=Array.from(el.querySelectorAll('[data-testid="document-thumb"]')).filter(own).map(e=>e.innerText.split('\n')[0].trim()).filter(Boolean);
    return {id:el.getAttribute('data-id'),rawTimestampAndSender:pre,messageText,documentNames,
      direction:outgoing?'outgoing':'unknown',delivery,rawDelivery,
      displayedTime:(el.innerText.match(/\b\d{1,2}:\d{2}\b/g)||[]).at(-1)||null,
      text:el.innerText,emoji:Array.from(el.querySelectorAll('img[alt]')).filter(own).map(e=>e.alt).filter(Boolean),links:Array.from(new Set(Array.from(el.querySelectorAll('a[href]')).filter(own).map(e=>e.href).filter(h=>/^https?:\/\//.test(h)))),attachments};
  }
  const read=async()=>{
    const result=[];
    // Loaded rows can be outside the viewport. Do not silently restrict to visible pixels.
    for(const row of await main.locator('[data-id]').all()) {
      if(await row.evaluate(e=>!!e.parentElement.closest('[data-id]'))) continue;
      result.push(await row.evaluate(inspectRow));
    }
    return result;
  };
  const scrollOlder=async()=>{
    const known=main.locator('[data-testid="conversation-panel-messages"]');
    if(await known.count()===1) { await known.evaluate(e=>e.scrollTop=0); }
    else {
      const did=await main.evaluate(m=>{ const els=Array.from(m.querySelectorAll('div')).filter(e=>e.scrollHeight>e.clientHeight+100&&e.clientHeight>150);const el=els.sort((a,b)=>a.clientHeight-b.clientHeight)[0];if(!el)return false;el.scrollTop=0;return true; });
      if(!did) error('HISTORY_CONTROL','No message scroller found. Use ui snapshot.');
    }
    await page.waitForTimeout(900);
  };
  if(op==='messages'||op==='links') {
    let collected=new Map();let stagnant=0,scrolls=0;
    for(let i=0;i<=(a.older||0);i++) {
      await guard(); const messages=await read();const before=collected.size;
      const ordered=new Map([...messages.map(m=>[m.id,m]),...collected]);
      for(const m of messages)ordered.set(m.id,m);
      collected=ordered;
      if(collected.size===before) stagnant++; else stagnant=0;
      if(i===(a.older||0)||stagnant>=2)break;
      await scrollOlder();scrolls++;
    }
    let messages=Array.from(collected.values());
    if(a.contains) messages=messages.filter(m=>(m.messageText+'\n'+m.text).toLocaleLowerCase().includes(a.contains.toLocaleLowerCase()));
    const totalCollected=messages.length;
    messages=messages.slice(-(a.limit||100));
    return {chat:a.chat,coverage:'partial_loaded_history',complete:false,scrolls,totalCollected,
      ...(op==='links'?{links:messages.flatMap(m=>m.links.map(url=>({messageId:m.id,rawTimestampAndSender:m.rawTimestampAndSender,url})))}:{messages})};
  }
  if(op==='download') {
    const escaped=a.message.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    const row=main.locator(`[data-id="${escaped}"]`);
    if(await row.count()!==1) error('MESSAGE_NOT_LOADED','Message is not uniquely loaded. Read/scroll the chat and use a current message ID.');
    const meta=await row.evaluate(inspectRow), attachment=meta.attachments[a.item||0];
    if(!attachment) error('ATTACHMENT_NOT_FOUND','No attachment with that item index.',{available:meta.attachments});
    const control=row.locator('button,[role="button"],a[download]').nth(attachment.buttonIndex);
    await control.scrollIntoViewIfNeeded();
    await guard();
    let openedViewer=false;
    try {
      let trigger=control;
      if(attachment.kind==='image'||attachment.kind==='video') {
        await control.click(); openedViewer=true;
        const buttons=page.getByRole('button',{name:/^(last ned|download|herunterladen|télécharger|descargar)$/i});
        await buttons.first().waitFor({state:'visible',timeout:8000});
        if(await buttons.count()!==1) error('DOWNLOAD_AMBIGUOUS','Could not identify one media-viewer download control.');
        trigger=buttons;
      }
      const pending=page.waitForEvent('download',{timeout:a.timeout||90000});
      pending.catch(()=>{});
      await trigger.click({timeout:10000});
      let download;
      try{download=await pending;}catch{error('DOWNLOAD_UNCONFIRMED','No download event was confirmed. Inspect the UI/downloads before retrying; a timeout alone does not prove nothing downloaded.');}
      const failure=await download.failure();
      if(failure) error('DOWNLOAD_FAILED',failure);
      await download.saveAs(a.savePath);
      return {filename:download.suggestedFilename()||attachment.filename,observed:{chat:a.chat,messageId:a.message,rawTimestampAndSender:meta.rawTimestampAndSender,displayedTime:meta.displayedTime,kind:attachment.kind}};
    } finally {
      if(openedViewer) {
        const close=page.getByRole('button',{name:/^(lukk|close|schließen|fermer|cerrar)$/i});
        if(await close.count()===1) await close.click().catch(()=>{});
      }
    }
  }
  const editor=()=>main.locator('footer [contenteditable="true"][role="textbox"]');
  const normalizeText=text=>text.replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').trim();
  const filePreview=(name)=>page.getByRole('tab',{name:new RegExp('(?:^|,\\s*)'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:,|$)')});
  const previewCount=async()=>{
    const send=page.getByRole('button',{name:/^(send \d+ selected|send \d+ valgte)$/i});
    if(await send.count()!==1||!await send.isVisible())return null;
    return Number((await send.getAttribute('aria-label')||await send.innerText()).match(/\b(\d+)\b/)?.[1]);
  };
  const assertEmpty=async()=>{
    if(await page.getByRole('button',{name:/^(send \d+ selected|send \d+ valgte)$/i}).count())error('EXISTING_PREVIEW','An attachment preview is already open. Inspect or close it before preparing new files.');
    const input=editor();
    if(await input.count()!==1 || !await input.isVisible()) error('COMPOSER_NOT_READY','One normal chat composer is required. Close any preview first.');
    if((await input.evaluate(inspectRow)).messageText) error('EXISTING_DRAFT','The chat already contains a draft; inspect it before replacing or adding files.');
  };
  if(op==='compose') {
    await assertEmpty(); await guard(); await editor().fill(a.text);
    return {chat:a.chat,status:'draft_prepared',text:(await editor().evaluate(inspectRow)).messageText,sent:false};
  }
  if(op==='upload') {
    await assertEmpty(); await guard();
    const inputs=page.locator('input[type="file"][accept="*"]');
    if(await inputs.count()===1) await inputs.setInputFiles(a.files);
    else {
      const menu=page.getByRole('menuitem',{name:/^(document|dokument)$/i});
      if(!await menu.isVisible().catch(()=>false)) {
        const attach=main.getByRole('button',{name:/^(attach|legg ved)$/i});
        if(await attach.count()!==1)error('UPLOAD_CONTROL','Could not identify the attachment menu. Inspect ui snapshot.');
        await attach.click();
      }
      await menu.waitFor({state:'visible',timeout:5000});
      await guard();
      await menu.click();
      return {fileChooserPending:true};
    }
    return {filesSet:true};
  }
  if(op==='verify-upload') {
    if(!a.quick)for(const file of a.files)await filePreview(file.split(/[\\/]/).at(-1)).first().waitFor({state:'visible',timeout:10000});
    if(await previewCount()!==a.files.length)error('NO_PREVIEW','Selected file count does not match the upload.');
    for(const file of a.files){const preview=filePreview(file.split(/[\\/]/).at(-1));if(await preview.count()!==1||!await preview.isVisible())error('NO_PREVIEW','Upload preview filenames do not match.');}
    await guard();
    return {chat:a.chat,status:'files_staged',files:a.files,sent:false,note:'Inspect ui snapshot before sending.'};
  }
  const requireExpected=()=>{
    if(!a.expected||!['text','files'].includes(a.expected.kind)||a.expected.chat!==a.chat)error('DRAFT_MISMATCH','Use compose or upload to prepare this chat before sending.');
    if(a.expected.kind==='text'&&(!a.expected.text||!normalizeText(a.expected.text)))error('DRAFT_MISMATCH','Prepared text is missing.');
    if(a.expected.kind==='files'&&(!Array.isArray(a.expected.names)||!a.expected.names.length||new Set(a.expected.names).size!==a.expected.names.length))error('DRAFT_MISMATCH','Prepared filenames are missing or ambiguous.');
  };
  const matchingSent=after=>{
    const before=new Set(a.before||[]);
    const added=after.filter(m=>!before.has(m.id)&&m.direction==='outgoing');
    if(a.expected.kind==='text')return added.filter(m=>m.messageText===normalizeText(a.expected.text)).slice(0,1);
    const found=[];
    for(const name of a.expected.names){
      const match=added.find(m=>!found.includes(m)&&(m.documentNames.includes(name)||m.attachments.some(f=>f.filename===name)));
      if(!match)return [];
      found.push(match);
    }
    return found;
  };
  const sendResult=matches=>({chat:a.chat,status:'outgoing_message_observed',messages:matches.map(m=>({messageId:m.id,delivery:m.delivery||'not_verified'}))});
  if(op==='send-check') {
    requireExpected();
    if(!Array.isArray(a.before))error('DRAFT_MISMATCH','No recorded send attempt to check.');
    const matches=matchingSent(await read());
    return matches.length?sendResult(matches):{chat:a.chat,status:'send_unresolved',note:'No matching outgoing content is currently loaded. Inspect history/UI; this does not prove the send failed.'};
  }
  if(op==='prepare-send'||op==='send') {
    if(a.authorized!==true) error('SEND_AUTHORIZATION','send requires --authorized and an explicit user request to send this content to this chat.');
    requireExpected();
    await guard();
    const buttons=page.getByRole('button',{name:sendPattern});
    if(await buttons.count()!==1) error('SEND_CONTROL','Expected exactly one Send button; inspect the prepared content.');
    const count=await previewCount();
    if(a.expected.kind==='text'){
      if(count!==null||await editor().count()!==1||!await editor().isVisible()||(await editor().evaluate(inspectRow)).messageText!==normalizeText(a.expected.text))error('DRAFT_CHANGED','The prepared text has changed or an attachment preview is open.');
    }else{
      if(a.expected.names.length!==count)error('DRAFT_CHANGED','Selected attachment count does not match the prepared files.');
      for(const file of a.expected.names){const preview=filePreview(file);if(await preview.count()!==1||!await preview.isVisible())error('DRAFT_CHANGED','The prepared file preview has changed.');}
    }
    a.before=(await read()).map(m=>m.id);
    if(op==='prepare-send')return {before:a.before};
    await guard();
    try { await buttons.click({timeout:10000}); }
    catch { error('SEND_UNCERTAIN','Send may have been activated. Inspect the chat; do not automatically retry.'); }
    for(let i=0;i<25;i++) {
      await page.waitForTimeout(400);
      try{await guard();}catch{error('SEND_UNCERTAIN','The selected chat changed after Send. Inspect the result; do not retry automatically.');}
      const after=await read();
      const added=matchingSent(after);
      if(added.length)return sendResult(added);
    }
    error('SEND_UNCERTAIN','No new outgoing bubble was confirmed. Inspect the chat; do not automatically retry.');
  }
  if(op==='open-link') {
    const list=(await read()).flatMap(m=>m.links);
    if(!list.includes(a.url)) error('LINK_NOT_OBSERVED','URL must match a link observed in the current chat.');
    const target=await page.context().newPage();await target.goto(a.url,{waitUntil:'domcontentloaded',timeout:30000});
    return {url:target.url(),opened:true};
  }
  error('UNKNOWN_OPERATION',`Unknown browser operation: ${op}`);
}
