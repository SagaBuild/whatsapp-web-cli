import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicPath,inspectPublicText,checkRelease} from '../scripts/check-release.mjs';

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
