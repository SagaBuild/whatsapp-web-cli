import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {publicPath,inspectPublicText,checkRelease} from '../scripts/check-release.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'wa-release-tests-'));
const source=fileURLToPath(new URL('../',import.meta.url));
after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
  const directory=await fs.mkdtemp(path.join(root,'case-')),checkout=path.join(directory,'source');
  const files=JSON.parse(await fs.readFile(path.join(source,'release-files.json'),'utf8'));
  for(const file of files){await fs.mkdir(path.dirname(path.join(checkout,file)),{recursive:true});await fs.copyFile(path.join(source,file),path.join(checkout,file));}
  return {directory,checkout,files,include:async file=>{
    files.push(file);await fs.writeFile(path.join(checkout,'release-files.json'),JSON.stringify(files));
  }};
}

test('Private browser artifacts and traversal cannot enter the public inventory',()=>{
  for(const file of ['STATE.md','profile/Cookies','node_modules/package.json','.work/result.json','.env','wa-manifest.json','prepared-draft.json','screenshots/chat.png','../outside.md','C:/private.md'])assert.equal(publicPath(file),false,file);
  for(const file of ['SKILL.md','LICENSE','.github/workflows/ci.yml','tests/setup.test.mjs'])assert.equal(publicPath(file),true,file);
});

test('Release scanning refuses synthetic credentials and private paths without printing them',()=>{
  for(const text of ['ghp_'+'a'.repeat(40),'C:/'+'Users/'+'private-person/'+'profile','-----BEGIN '+'PRIVATE KEY-----']){
    assert.throws(()=>inspectPublicText('fixture.md',text),error=>error.code==='PRIVATE_RELEASE_CONTENT'&&!error.message.includes(text));
  }
  assert.doesNotThrow(()=>inspectPublicText('README.md','Use your own Linked devices screen.'));
});

test('The actual public file inventory, local links and package metadata are consistent',async()=>{
  const result=await checkRelease();assert.equal(result.privateArtifactsIncluded,false);assert.ok(result.files>20);
});

test('The integrated release checker rejects forbidden files added to an otherwise valid archive',async()=>{
  for(const file of ['profile/synthetic.json','prepared-draft.json','STATE.md']){
    const f=await fixture();assert.equal((await checkRelease(f.checkout)).gitChecked,false);
    await fs.mkdir(path.dirname(path.join(f.checkout,file)),{recursive:true});
    await fs.writeFile(path.join(f.checkout,file),'Synthetic private fixture');await f.include(file);
    await assert.rejects(checkRelease(f.checkout),{code:'PRIVATE_RELEASE_PATH'});
  }
});

test('The integrated release checker scans inventoried file content and never echoes its canary',async()=>{
  const f=await fixture();await checkRelease(f.checkout);
  const canary='ghp_'+'x'.repeat(40);
  await fs.appendFile(path.join(f.checkout,'README.md'),'\nSynthetic credential: '+canary+'\n');
  await assert.rejects(checkRelease(f.checkout),error=>error.code==='PRIVATE_RELEASE_CONTENT'&&!error.message.includes(canary));
});

test('The release checker rejects directory links escaping the archive without changing their target',async()=>{
  const f=await fixture(),outside=path.join(f.directory,'outside');await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'entry.mjs'),'// synthetic outside sentinel');
  await fs.symlink(outside,path.join(f.checkout,'linked'),process.platform==='win32'?'junction':'dir');
  await f.include('linked/entry.mjs');
  await assert.rejects(checkRelease(f.checkout),{code:'RELEASE_FILE'});
  assert.equal(await fs.readFile(path.join(outside,'entry.mjs'),'utf8'),'// synthetic outside sentinel');
});
