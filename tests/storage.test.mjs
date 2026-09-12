import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {safeFilename,saveDownload,hashFile,withLock} from '../scripts/storage.mjs';

const scratch=fileURLToPath(new URL('../.work/storage-tests/',import.meta.url));
await fs.mkdir(scratch,{recursive:true});
const root=await fs.mkdtemp(path.join(scratch,'run-'));
after(async()=>{assert.equal(path.dirname(root),path.resolve(scratch));await fs.rm(root,{recursive:true,force:true});});

test('Unicode filenames survive while Windows path traversal and device names cannot escape',()=>{
  assert.equal(safeFilename('English-英语（美国）.zip'),'English-英语（美国）.zip');
  for(const input of ['../outside.zip','..\\outside.zip','C:\\Windows\\file','CON.txt','NUL','LPT1.jpg','bad\x00name. ']){
    const n=safeFilename(input);assert.ok(!/[\\/:\x00]/.test(n));assert.ok(!/[. ]$/.test(n));assert.ok(!/^(con|nul|lpt1)(\.|$)/i.test(n));
  }
});

test('Downloads deduplicate by actual hash, preserve collisions, and repair corrupted originals',async()=>{
  const out=await fs.mkdtemp(path.join(root,'files-'));let calls=0;
  const source={session:'fixture',chat:'测试',messageId:'m1',item:0};
  const get=async(file)=>{calls++;await fs.writeFile(file,Buffer.from('original bytes'));return {filename:'挪威语.zip'};};
  const first=await saveDownload(out,source,get);
  assert.equal(first.status,'saved');assert.equal(first.bytes,14);
  const repeat=await saveDownload(out,source,get);assert.equal(repeat.status,'skipped_verified');assert.equal(calls,1);
  await fs.writeFile(first.path,'corrupt');
  const repair=await saveDownload(out,source,get);assert.equal(repair.status,'saved');assert.notEqual(repair.path,first.path);
  assert.equal(await fs.readFile(first.path,'utf8'),'corrupt');
  assert.equal((await hashFile(repair.path)).sha256,first.sha256);
  const other=await saveDownload(out,{...source,messageId:'m2'},get);assert.notEqual(other.path,repair.path);
});

test('SHA-256 receipts use a fixed known digest and detect equal-length corruption',async()=>{
  const out=await fs.mkdtemp(path.join(root,'same-size-')),known=path.join(out,'known.txt');
  await fs.writeFile(known,'abc');
  assert.deepEqual(await hashFile(known),{bytes:3,sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'});
  let downloads=0;
  const source={messageId:'same-size'},download=async file=>{downloads++;await fs.writeFile(file,'original bytes');return {filename:'payload.txt'};};
  const first=await saveDownload(out,source,download);
  await fs.writeFile(first.path,'modified bytes');
  assert.equal((await fs.stat(first.path)).size,first.bytes);
  const repaired=await saveDownload(out,source,download);
  assert.equal(repaired.status,'saved');assert.equal(downloads,2);
  assert.notEqual(repaired.path,first.path);
  assert.equal(await fs.readFile(repaired.path,'utf8'),'original bytes');
  assert.equal(await fs.readFile(first.path,'utf8'),'modified bytes');
});

for(const operation of ['write','rename'])test(`A manifest ${operation} failure rolls back only its new payload and cleans staging before retry`,async t=>{
  const out=await fs.mkdtemp(path.join(root,'commit-failure-'));
  const download=filename=>async file=>{await fs.writeFile(file,'synthetic bytes');return {filename};};
  const first=await saveDownload(out,{messageId:'existing'},download('existing.txt'));
  // saveDownload canonicalizes paths; use its returned directory on aliased /tmp volumes too.
  const directory=path.dirname(first.path),manifest=path.join(directory,'wa-manifest.json');
  const previous=await fs.readFile(manifest,'utf8');
  const original=fs[operation==='write'?'writeFile':'rename'].bind(fs);
  t.mock.method(fs,operation==='write'?'writeFile':'rename',async(...args)=>{
    const isCommit=operation==='write'?path.basename(args[0]).startsWith('.wa-manifest-'):path.resolve(args[1])===manifest;
    if(!isCommit)return original(...args);
    if(operation==='write')await original(args[0],'synthetic partial manifest',args[2]);
    throw Object.assign(Error('Synthetic manifest commit failure'),{code:operation==='write'?'ENOSPC':'EACCES'});
  });
  await assert.rejects(saveDownload(out,{messageId:'new'},download('new.txt')),{code:operation==='write'?'ENOSPC':'EACCES'});
  assert.equal(await fs.readFile(manifest,'utf8'),previous);
  assert.equal(await fs.readFile(first.path,'utf8'),'synthetic bytes');
  assert.deepEqual((await fs.readdir(directory)).sort(),['existing.txt','wa-manifest.json']);
  t.mock.restoreAll();
  const retry=await saveDownload(out,{messageId:'new'},download('new.txt'));
  assert.equal(retry.savedFilename,'new.txt');assert.equal(retry.status,'saved');
  assert.equal(JSON.parse(await fs.readFile(manifest,'utf8')).files.length,2);
});

test('Rollback preserves a new payload that another writer changed before the commit failed',async t=>{
  const out=await fs.mkdtemp(path.join(root,'changed-during-commit-'));
  const rename=fs.rename.bind(fs);
  t.mock.method(fs,'rename',async(source,target)=>{
    if(path.basename(target)!=='wa-manifest.json')return rename(source,target);
    await fs.writeFile(path.join(path.dirname(target),'payload.txt'),'independent writer content');
    throw Object.assign(Error('Synthetic commit failure after an external edit'),{code:'EACCES'});
  });
  await assert.rejects(saveDownload(out,{messageId:'changed'},async file=>{await fs.writeFile(file,'downloaded content');return {filename:'payload.txt'};}),{code:'EACCES'});
  assert.equal(await fs.readFile(path.join(out,'payload.txt'),'utf8'),'independent writer content');
  assert.deepEqual(await fs.readdir(out),['payload.txt']);
});

test('Failed or empty downloads create no success receipt',async()=>{
  const out=await fs.mkdtemp(path.join(root,'failed-'));
  await assert.rejects(saveDownload(out,{messageId:'m'},async file=>{await fs.writeFile(file,'');return {filename:'empty.zip'};}),{code:'EMPTY_DOWNLOAD'});
  assert.deepEqual(await fs.readdir(out),[]);
  await fs.writeFile(path.join(out,'wa-manifest.json'),'not json');
  await assert.rejects(saveDownload(out,{},async()=>{}),{code:'MANIFEST_INVALID'});
  assert.equal(await fs.readFile(path.join(out,'wa-manifest.json'),'utf8'),'not json');
});

test('A concurrent command cannot claim a live session lock',async()=>{
  const dir=await fs.mkdtemp(path.join(root,'lock-')),lock=path.join(dir,'session.lock');
  await withLock(lock,async()=>assert.rejects(withLock(lock,async()=>assert.fail('must not execute')),{code:'BUSY'}));
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('Finishing a command never removes a replacement lock owner',async()=>{
  const directory=await fs.mkdtemp(path.join(root,'lock-successor-')),lock=path.join(directory,'session.lock');
  const successor={pid:process.pid,token:'synthetic-successor'};
  await withLock(lock,async()=>{await fs.writeFile(lock,JSON.stringify(successor));});
  assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),successor);
});

test('Long Unicode names preserve extensions within a portable byte budget',()=>{
  for(const input of ['文'.repeat(176)+'.zip','a'+'💬'.repeat(100)+'.zip','Cafe\u0301'.repeat(80)+'.zip']){
    const name=safeFilename(input);
    assert.ok(Buffer.byteLength(name,'utf8')<=180);
    assert.ok(name.endsWith('.zip'));
    assert.equal(name,Buffer.from(name).toString('utf8'));
    assert.equal(name,name.normalize('NFC'));
  }
  const longExtension=safeFilename('文'.repeat(100)+'.'+'💬'.repeat(20));
  assert.ok(Buffer.byteLength(path.extname(longExtension),'utf8')<=20);
  assert.ok(Buffer.byteLength(longExtension,'utf8')<=180);
  for(const input of ['a'.repeat(179)+' '+'b'.repeat(20),'a'.repeat(179)+'.'+'b'.repeat(30)]){
    assert.ok(!/[. ]$/.test(safeFilename(input)));
  }
});

test('Truncation and trailing-space cleanup cannot recreate Windows device names',async()=>{
  for(const device of ['CON','con','PRN','AUX','NUL','COM1','COM9','LPT1','LPT9']){
    assert.equal(safeFilename(device+' '.repeat(200)+'x'),'_'+device);
  }
  // Assert the safe result before attempting I/O so a regression never opens a device.
  const filename='CON'+' '.repeat(200)+'x';assert.equal(safeFilename(filename),'_CON');
  const out=await fs.mkdtemp(path.join(root,'reserved-after-truncation-'));
  const saved=await saveDownload(out,{messageId:'synthetic-reserved'},async file=>{
    await fs.writeFile(file,'synthetic attachment');return {filename};
  });
  assert.equal(saved.savedFilename,'_CON');
  assert.equal(await fs.readFile(saved.path,'utf8'),'synthetic attachment');
});

test('Long CJK, emoji and decomposed download names save distinct collision payloads',async()=>{
  const names=['文'.repeat(176)+'.zip','💬'.repeat(100)+'.txt','Cafe\u0301'.repeat(80)+'.txt'];
  for(const [index,filename] of names.entries()){
    const out=await fs.mkdtemp(path.join(root,'unicode-files-'));
    const results=[];
    for(let copy=0;copy<2;copy++){
      const payload=`synthetic attachment ${index} copy ${copy}`;
      const receipt=await saveDownload(out,{messageId:`unicode-${index}-${copy}`},async file=>{
        await fs.writeFile(file,payload);
        return {filename};
      });
      assert.equal(receipt.status,'saved');
      assert.equal(await fs.readFile(receipt.path,'utf8'),payload);
      assert.ok(Buffer.byteLength(receipt.savedFilename,'utf8')<=186);
      assert.equal(receipt.savedFilename,receipt.savedFilename.normalize('NFC'));
      assert.equal(path.extname(receipt.savedFilename),path.extname(filename));
      results.push(receipt);
    }
    assert.notEqual(results[0].path,results[1].path);
    assert.notEqual(results[0].sha256,results[1].sha256);
    assert.equal(await fs.readFile(results[0].path,'utf8'),`synthetic attachment ${index} copy 0`);
    assert.equal(JSON.parse(await fs.readFile(path.join(out,'wa-manifest.json'),'utf8')).files.length,2);
  }
});

test('Download names cannot overwrite the manifest or occupy internal lock names',async()=>{
  for(const filename of ['wa-manifest.json','WA-MANIFEST.JSON','.wa-download.lock.reclaim']) {
    const out=await fs.mkdtemp(path.join(root,'reserved-'));
    const source={messageId:filename};
    const saved=await saveDownload(out,source,async file=>{
      await fs.writeFile(file,'original attachment bytes');
      return {filename};
    });
    assert.equal(await fs.readFile(saved.path,'utf8'),'original attachment bytes');
    assert.notEqual(saved.savedFilename.toLowerCase(),'wa-manifest.json');
    assert.ok(!saved.savedFilename.toLowerCase().startsWith('.wa-'));
    assert.equal(JSON.parse(await fs.readFile(path.join(out,'wa-manifest.json'),'utf8')).files.length,1);
    assert.equal((await saveDownload(out,source,async()=>assert.fail('Verified attachment must be reused'))).status,'skipped_verified');
  }
});

test('A failed command releases its lock and malformed owners stay locked',async()=>{
  const dir=await fs.mkdtemp(path.join(root,'lock-failure-')),lock=path.join(dir,'session.lock');
  await assert.rejects(withLock(lock,async()=>{throw new Error('synthetic failure');}),/synthetic failure/);
  assert.deepEqual(await fs.readdir(dir),[]);
  for(const owner of [null,{}, {pid:0},{pid:-1},{pid:'invalid'}]) {
    await fs.writeFile(lock,JSON.stringify(owner));
    await assert.rejects(withLock(lock,async()=>assert.fail('Must not enter a malformed lock')),{code:'BUSY'});
    assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),owner);
  }
});

test('Stale lock reclamation admits only one concurrent command',async()=>{
  const dir=await fs.mkdtemp(path.join(root,'lock-race-')),lock=path.join(dir,'session.lock');
  // An already-exited child gives a real stale PID without probing unrelated processes.
  const {spawn}=await import('node:child_process');
  const child=spawn(process.execPath,['-e',''],{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  await fs.writeFile(lock,JSON.stringify({pid:child.pid,token:'stale'}));
  let active=0,maxActive=0;
  const results=await Promise.allSettled(Array.from({length:20},()=>withLock(lock,async()=>{
    active++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>setTimeout(resolve,50));
    active--;
  })));
  assert.equal(maxActive,1);
  assert.ok(results.some(r=>r.status==='fulfilled'));
  for(const result of results.filter(r=>r.status==='rejected'))assert.equal(result.reason.code,'BUSY');
  assert.deepEqual(await fs.readdir(dir),[]);
});
