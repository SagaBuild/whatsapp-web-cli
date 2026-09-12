#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkRequirements,executeNode} from './platform.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const report={platform:process.platform,architecture:process.arch,node:process.versions.node,realAccountUsed:false};
try{
  report.version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
  await checkRequirements();report.chromeDetected=true;
  let files;
  try{files=(await fs.readdir(path.join(root,'tests'))).filter(file=>file.endsWith('.test.mjs')).sort();}
  catch{throw Object.assign(Error('Run npm run verify from the source checkout; use the CLI doctor command for an installed skill.'),{code:'SOURCE_REQUIRED'});}
  if(!files.length)throw Object.assign(Error('The source test suite is missing.'),{code:'SOURCE_REQUIRED'});
  const result=await executeNode(['--test','--test-reporter=tap',...files.map(file=>path.join(root,'tests',file))],{cwd:root,timeout:300000});
  const passed=result.stdout.match(/^# pass (\d+)$/m),failed=result.stdout.match(/^# fail (\d+)$/m);
  if(!passed||!failed||Number(passed[1])===0||Number(failed[1])!==0)throw Object.assign(Error('Test results could not be confirmed.'),{code:'VERIFY_FAILED'});
  console.log(JSON.stringify({ok:true,...report,testsPassed:Number(passed[1]),testsFailed:0}));
}catch(error){
  await fs.mkdir(path.join(root,'.work'),{recursive:true});
  await fs.writeFile(path.join(root,'.work','verification.log'),String(error.message),{mode:0o600});
  console.log(JSON.stringify({ok:false,...report,error:{code:error.code||'VERIFY_FAILED',message:'See .work/verification.log locally, or run npm test for details. Share only this summary; it contains no account or home-directory paths.'}}));
  process.exitCode=1;
}
