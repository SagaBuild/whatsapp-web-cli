import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataRoot,chromeCandidates,checkRequirements,npmEntry,samePath,executeNode} from '../scripts/platform.mjs';

const source=fileURLToPath(new URL('../',import.meta.url));
const scratch=path.join(source,'.work','platform-tests');await fs.mkdir(scratch,{recursive:true});
const root=await fs.mkdtemp(path.join(scratch,'run-'));
after(async()=>{assert.equal(path.dirname(root),path.resolve(scratch));await fs.rm(root,{recursive:true,force:true});});

test('macOS discovers system and user Chrome installations, with an explicit executable or app override',async()=>{
  const home='/synthetic/Person A',options={platform:'darwin',env:{},home};
  const system='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const user=home+'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.deepEqual(chromeCandidates(options),[system,user]);
  assert.equal((await checkRequirements({candidates:chromeCandidates(options),exists:async file=>file===user})).chrome,user);
  for(const value of [home+'/Applications/Google Chrome.app',user])assert.deepEqual(chromeCandidates({...options,env:{WA_CHROME_PATH:value}}),[user]);
  assert.throws(()=>chromeCandidates({...options,env:{WA_CHROME_PATH:'relative.app'}}),{code:'CHROME_PATH'});
  await assert.rejects(checkRequirements({candidates:chromeCandidates({...options,env:{WA_CHROME_PATH:'/missing/chrome'}}),exists:async file=>file===system}),{code:'CHROME_MISSING'});
});

test('Windows data and Chrome overrides require a drive root or complete UNC path',()=>{
  for(const value of ['\\synthetic-data\\whatsapp','/synthetic-data/whatsapp','C:relative','\\\\server']){
    assert.throws(()=>dataRoot({platform:'win32',env:{WA_DATA_DIR:value},home:'C:\\synthetic'}),{code:'DATA_DIRECTORY'},value);
    assert.throws(()=>chromeCandidates({platform:'win32',env:{WA_CHROME_PATH:value},home:'C:\\synthetic'}),{code:'CHROME_PATH'},value);
  }
  for(const value of ['C:\\synthetic\\data','D:/synthetic/data','\\\\server\\share\\data','//server/share/data','\\\\?\\C:\\synthetic\\data','\\\\?\\UNC\\server\\share\\data']){
    assert.equal(dataRoot({platform:'win32',env:{WA_DATA_DIR:value}}),path.win32.normalize(value));
    assert.deepEqual(chromeCandidates({platform:'win32',env:{WA_CHROME_PATH:value}}),[path.win32.normalize(value)]);
  }
  assert.throws(()=>dataRoot({platform:'win32',env:{LOCALAPPDATA:'\\application-data'}}),{code:'DATA_DIRECTORY'});
  assert.equal(dataRoot({platform:'darwin',env:{WA_DATA_DIR:'/synthetic/data'}}),'/synthetic/data');
});

test('Direct installation resolves npm in macOS Intel, Apple Silicon and nvm layouts',async()=>{
  for(const prefix of ['/usr/local','/opt/homebrew','/synthetic/.nvm/versions/node/v24.0.0']){
    const wanted=prefix+'/lib/node_modules/npm/bin/npm-cli.js';
    assert.equal(await npmEntry({platform:'darwin',env:{},execPath:prefix+'/bin/node',realpath:async file=>file,isFile:async file=>file===wanted}),wanted);
  }
});

test('npm symlinks and npm-run metadata work without invoking a shell',async()=>{
  const wanted='/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js';
  assert.equal(await npmEntry({platform:'darwin',execPath:'/opt/homebrew/Cellar/node/24/bin/node',env:{PATH:'/opt/homebrew/bin'},
    realpath:async file=>file==='/opt/homebrew/bin/npm'?wanted:file,isFile:async file=>file===wanted}),wanted);
  const custom='/synthetic/custom/npm-cli.js';
  assert.equal(await npmEntry({platform:'darwin',execPath:'/missing/bin/node',env:{npm_execpath:custom},realpath:async file=>file,isFile:async file=>file===custom}),custom);
  await assert.rejects(npmEntry({platform:'darwin',execPath:'/missing/bin/node',env:{npm_execpath:'relative/npm-cli.js'},realpath:async file=>file,isFile:async()=>false}),{code:'NPM_MISSING'});
});

test('Filesystem identity accepts aliases and case-insensitive identities, but refuses distinct case-sensitive profiles',async()=>{
  const sameVolume={paths:path.posix,realpath:async file=>file,stat:async()=>({dev:1n,ino:5n})};
  assert.equal(await samePath('/var/example','/private/var/example',sameVolume),true);
  assert.equal(await samePath('/volume/Profile','/volume/profile',sameVolume),true);
  const distinct={...sameVolume,stat:async file=>({dev:1n,ino:file.includes('/Profile')?5n:6n})};
  assert.equal(await samePath('/volume/Profile','/volume/profile',distinct),false);
  assert.equal(await samePath('/missing/a','/missing/b',{...sameVolume,realpath:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}}),false);
});

test('CLI entrypoints invoked through a real directory alias execute and preserve Unicode paths with spaces',async()=>{
  const alias=path.join(root,'alias 团队 space');
  await fs.symlink(source,alias,process.platform==='win32'?'junction':'dir');
  assert.equal(await samePath(source,alias),true);
  for(const [file,args] of [['wa.mjs',['help']],['setup.mjs',['--help']],['install.mjs',['--help']]]){
    const result=await executeNode([path.join(alias,'scripts',file),...args],{cwd:root});
    assert.ok(result.stdout.trim(),`${file} must not silently exit through a symlink`);
  }
});
