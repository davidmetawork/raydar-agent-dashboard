import {spawn,execFileSync} from 'node:child_process';
import {openSync,closeSync,constants} from 'node:fs';
import {mkdir,readFile,rm,chmod,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MARKER,STATE_ROOT,assertPreviewDatabase} from './config.mjs';
import {createDatabase} from '../api/submissions-v2/_lib/db.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),serverPath=resolve(root,'submissions-preview/server.mjs');
const databaseUrl='postgresql://submissions_dev@127.0.0.1:55439/submissions_preview';
const url='http://127.0.0.1:4525';
const command=process.argv[2]||'status';
async function live(){try{const response=await fetch(`${url}/live`,{signal:AbortSignal.timeout(1500)});const value=await response.json();return response.ok&&value.test_environment===true;}catch{return false;}}
async function stop(){
  let pid;try{pid=Number(await readFile(resolve(STATE_ROOT,'preview.pid'),'utf8'));}catch{return;}
  if(!Number.isSafeInteger(pid)||pid<=1)throw new Error('Refusing invalid preview process ID.');
  let args;try{args=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});}catch{return;}
  if(!args.includes(serverPath))throw new Error('Refusing to stop a process that is not this preview server.');
  process.kill(pid,'SIGTERM');
  for(let i=0;i<40;i++){if(!await live())return;await new Promise(resolve=>setTimeout(resolve,250));}
  throw new Error('The preview is still shutting down; its active job may need to finish.');
}
if(command==='start'){
  if(await live()){console.log(`Already running: ${url}`);process.exit(0);}
  assertPreviewDatabase(databaseUrl,MARKER);await mkdir(STATE_ROOT,{recursive:true,mode:0o700});
  if((await lstat(STATE_ROOT)).isSymbolicLink())throw new Error('Preview state directory cannot be a symbolic link.');
  await chmod(STATE_ROOT,0o700);
  const fd=openSync(resolve(STATE_ROOT,'preview.log'),constants.O_APPEND|constants.O_CREAT|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  const child=spawn(process.execPath,[serverPath],{cwd:root,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:process.env.HOME||'',SUBMISSIONS_PREVIEW_DATABASE_URL:databaseUrl,SUBMISSIONS_PREVIEW_MARKER:MARKER}});
  closeSync(fd);child.unref();
  for(let i=0;i<60;i++){if(await live()){console.log(`Ready: ${url}`);process.exit(0);}await new Promise(resolve=>setTimeout(resolve,500));}
  throw new Error(`Preview did not become ready. Inspect ${resolve(STATE_ROOT,'preview.log')}.`);
}else if(command==='stop'){await stop();console.log('Preview stopped.');}
else if(command==='status'){console.log(await live()?`Running: ${url}`:'Preview is stopped.');}
else if(command==='reset'){
  if(!process.argv.includes('--confirm=RESET_TEST_DATA'))throw new Error('Reset removes only synthetic preview data. Pass --confirm=RESET_TEST_DATA to confirm.');
  assertPreviewDatabase(databaseUrl,MARKER);await stop();
  const sql=createDatabase({databaseUrl,max:1});
  try{
    const row=(await sql`select marker from preview.environment where singleton`)[0];if(row?.marker!==MARKER)throw new Error('Reset refused: isolated database marker did not match.');
    await sql.unsafe('drop schema submissions_v2 cascade; drop schema preview cascade;');
    await rm(resolve(STATE_ROOT,'private-objects'),{recursive:true,force:true});
  }finally{await sql.end({timeout:5});}
  console.log('Synthetic preview state reset. Run start to create a fresh test workspace.');
}else throw new Error('Use start, stop, status, or reset --confirm=RESET_TEST_DATA.');
