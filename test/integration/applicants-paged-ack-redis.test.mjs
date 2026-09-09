import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { storePagedAcknowledgements } from '../../api/applicants/paged-sync.mjs';
import { K } from '../../api/applicants/_lib/kv.mjs';

const execute=promisify(execFile);
test('atomic paged acknowledgements preserve delivered evidence without a current decision',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'applicant-ack-redis-'));
  const socket=join(directory,'redis.sock');
  const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700',
    '--save','','--appendonly','no','--protected-mode','yes','--dir',directory],{stdio:'ignore'});
  let launchError;server.on('error',error=>{launchError=error;});
  const command=async args=>{
    const {stdout}=await execute('redis-cli',['--json','-s',socket,...args.map(String)]);
    return JSON.parse(stdout);
  };
  t.after(async()=>{
    const closed=new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
    await command(['SHUTDOWN','NOSAVE']).catch(()=>{});
    if(server.exitCode===null)server.kill('SIGTERM');
    await closed;await rm(directory,{recursive:true,force:true});
  });
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    if(launchError)throw launchError;
    if(await command(['PING']).then(value=>value==='PONG',()=>false)){ready=true;break;}
    await delay(20);
  }
  assert.ok(ready,'isolated Redis must start');
  const protectedStatuses=['invited','mailroom_accepted','sendgrid_delivered','scheduler_verified','ready_to_email','waiting_for_provider'];
  const old=new Map();
  const items=protectedStatuses.map((status,i)=>{
    const key=`core:protected-${i}`,ack={requestId:`prior-${i}`,status,providerMessageId:`provider-${i}`};
    old.set(key,ack);
    return {id:`ack-${i}`,requestId:`incoming-${i}`,monitorKey:key,createdAt:'2026-09-09T00:00:00Z',
      ackPayload:{requestId:`incoming-${i}`,status:'blocked'}};
  });
  for(const [key,ack]of old)await command(['HSET',K.acks,key,JSON.stringify(ack)]);
  const other={id:'other-ack',requestId:'old-request',monitorKey:'core:other',createdAt:'2026-09-09T00:00:00Z',
    ackPayload:{requestId:'old-request',status:'requested'}};
  await command(['HSET',K.decisions,other.monitorKey,JSON.stringify({requestId:'newer-request'})]);
  const fresh={id:'fresh-ack',requestId:'fresh-request',monitorKey:'core:fresh',createdAt:'2026-09-09T00:00:00Z',
    ackPayload:{requestId:'fresh-request',status:'requested'}};
  const receipts=await storePagedAcknowledgements([...items,other,fresh],{kvImpl:command});
  assert.deepEqual(receipts.slice(0,6).map(row=>row.state),Array(6).fill('preserved_delivery'));
  assert.equal(receipts[6].state,'superseded');assert.equal(receipts[7].state,'stored');
  for(const [key,ack]of old)assert.deepEqual(JSON.parse(await command(['HGET',K.acks,key])),ack);
  assert.equal(await command(['HGET',K.acks,other.monitorKey]),null);
  assert.deepEqual(JSON.parse(await command(['HGET',K.acks,fresh.monitorKey])),{...fresh.ackPayload,at:fresh.createdAt});
  const retry=await storePagedAcknowledgements([...items,other,fresh],{kvImpl:command});
  assert.deepEqual(retry,receipts);
});
