import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function fail(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

export function safeFilename(value) {
  let name = String(value || 'attachment').toWellFormed().normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = 'attachment';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  const truncate = (text, limit) => {
    let result='',bytes=0;
    for(const character of text){
      const size=Buffer.byteLength(character,'utf8');
      if(bytes+size>limit)break;
      result+=character;bytes+=size;
    }
    return result;
  };
  // Keep multibyte names below common 255-byte filesystem component limits,
  // leaving room for the downloader's reserved-name prefix and collision suffix.
  if (Buffer.byteLength(name,'utf8') > 180) {
    const originalExt=path.extname(name),ext=truncate(originalExt,20);
    const stem=name.slice(0,name.length-originalExt.length);
    name=truncate(stem,180-Buffer.byteLength(ext,'utf8'))+ext;
  }
  name=name.replace(/[. ]+$/g,'');
  if (!name || /^\.+$/.test(name)) name='attachment';
  return name;
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

export async function withLock(file, fn) {
  await fs.mkdir(path.dirname(file), { recursive:true });
  let handle;
  const busy = (details={}) => fail('BUSY','Another command owns this session or download directory, or its lock needs inspection.',{file,...details});
  try { handle = await fs.open(file, 'wx'); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Serialize stale-owner recovery. Otherwise two contenders can both read the
    // dead PID and the second can unlink the first contender's newly acquired lock.
    const reclaimFile=`${file}.reclaim`;
    let reclaim;
    try { reclaim=await fs.open(reclaimFile,'wx'); }
    catch(e) { if(e.code==='EEXIST')throw busy({reclaimFile});throw e; }
    try {
      let owner,missing=false;
      try { owner=JSON.parse(await fs.readFile(file,'utf8')); }
      catch(e) { if(e.code==='ENOENT')missing=true;else throw busy(); }
      if(!missing) {
        if(!owner || !Number.isSafeInteger(owner.pid) || owner.pid<=0 || owner.pid>2147483647)throw busy();
        let alive=true;
        try { process.kill(owner.pid,0); } catch(e) { if(e.code==='ESRCH')alive=false; }
        if(alive)throw busy({pid:owner.pid});
        await fs.unlink(file);
      }
      try { handle=await fs.open(file,'wx'); }
      catch(e) { if(e.code==='EEXIST')throw busy();throw e; }
    } finally {
      await reclaim.close();
      await fs.unlink(reclaimFile);
    }
  }
  const token = randomUUID();
  try { await handle.writeFile(JSON.stringify({ pid:process.pid, token, createdAt:new Date().toISOString() })); }
  catch(e) {
    await handle.close();
    await fs.unlink(file).catch(()=>{});
    throw e;
  }
  await handle.close();
  try { return await fn(); }
  finally {
    try { if (JSON.parse(await fs.readFile(file,'utf8')).token===token) await fs.unlink(file); } catch {}
  }
}

async function readManifest(directory) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(directory,'wa-manifest.json'),'utf8'));
    if (data.schemaVersion!==1 || !Array.isArray(data.files)) throw Error('invalid schema');
    return data;
  } catch(e) {
    if(e.code==='ENOENT') return {schemaVersion:1,files:[]};
    throw fail('MANIFEST_INVALID','The existing download manifest could not be read. It has not been replaced.');
  }
}

export async function saveDownload(directory, source, download) {
  directory = path.resolve(directory);
  await fs.mkdir(directory,{recursive:true});
  directory = await fs.realpath(directory);
  return withLock(path.join(directory,'.wa-download.lock'),async()=> {
    const manifest = await readManifest(directory);
    const key = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    for(const old of manifest.files.filter(x=>x.key===key).reverse()) {
      const file = path.resolve(directory,old.savedFilename);
      if (path.dirname(file)!==directory) continue;
      try {
        const st = await fs.lstat(file);
        if(!st.isFile()||st.isSymbolicLink()) continue;
        const actual = await hashFile(file);
        if(actual.bytes===old.bytes && actual.sha256===old.sha256) return {...old,path:file,status:'skipped_verified'};
      } catch(e) { if(e.code!=='ENOENT') throw e; }
    }
    const temporary = path.join(directory,`.wa-part-${randomUUID()}`);
    try {
      const result = await download(temporary);
      const content = await hashFile(temporary);
      if (!content.bytes) throw fail('EMPTY_DOWNLOAD','Download produced an empty file.');
      const originalFilename = result.filename || 'attachment';
      let wanted = safeFilename(originalFilename);
      // The receipt and lock namespace belong to the downloader, including when
      // no manifest has been written yet. These names must never become payloads.
      if(/^wa-manifest\.json$/i.test(wanted)||/^\.wa-/i.test(wanted))wanted=`_${wanted}`;
      const ext = path.extname(wanted), stem = wanted.slice(0,wanted.length-ext.length);
      let savedFilename, target;
      for(let i=0;i<1000;i++) {
        savedFilename = i ? `${stem} (${i})${ext}` : wanted;
        target = path.join(directory,savedFilename);
        try { await fs.copyFile(temporary,target,constants.COPYFILE_EXCL); break; }
        catch(e) { if(e.code!=='EEXIST') throw e; if(i===999) throw fail('NAME_COLLISIONS','Too many files with the same name.'); }
      }
      const receipt = { key, ...source, originalFilename, savedFilename, path:target, ...content,
        savedAt:new Date().toISOString(), observed:result.observed || null };
      manifest.files.push(receipt);
      const staging = path.join(directory,`.wa-manifest-${randomUUID()}.tmp`);
      await fs.writeFile(staging,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
      await fs.rename(staging,path.join(directory,'wa-manifest.json'));
      return {...receipt,status:'saved'};
    } finally { await fs.rm(temporary,{force:true}); }
  });
}
