import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import postgres from 'postgres';
import {pgCompatibleReadClient} from '../api/applicants/_lib/read-pool-adapter.mjs';

const url=process.env.APPLICANT_READ_TEST_DATABASE_URL;
const enabled=Boolean(url),run=(name,fn)=>test(name,{skip:!enabled},fn);
let sql;
before(async()=>{
  if(!enabled)return;
  const parsed=new URL(url);
  assert.ok(['127.0.0.1','localhost'].includes(parsed.hostname));
  assert.match(parsed.pathname,/^\/applicant_.*test_[a-z0-9_]+$/u);
  sql=postgres(url,{max:1,prepare:false,idle_timeout:2,connect_timeout:5,onnotice:()=>{}});
});
after(async()=>{await sql?.end();});
async function read(fn){
  const client=pgCompatibleReadClient(await sql.reserve());
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return await fn(client);
  }finally{await client.query('ROLLBACK');client.release();}
}

run('actual postgres.js reproduces double encoding and the read adapter preserves a JSON object',async()=>{
  const request={generationId:'11111111-1111-4111-8111-111111111111',generationDigest:'d'.repeat(64),
    applicationId:'22222222-2222-4222-8222-222222222222',rowDigest:'e'.repeat(64)};
  const text=JSON.stringify(request);
  const broken=(await sql.unsafe('SELECT $1::jsonb AS value',[text]))[0].value;
  assert.equal(typeof broken,'string');assert.equal(broken,text);
  await read(async client=>{
    const row=(await client.query('SELECT $1::jsonb AS value,jsonb_typeof($1::jsonb) AS kind',[text])).rows[0];
    assert.equal(row.kind,'object');assert.deepEqual(row.value,request);
  });
});

run('generation, view, filter, cursor, detail and acknowledgement identities survive exact SQL casts',async()=>{
  const requests=[
    {generationId:'11111111-1111-4111-8111-111111111111',generationDigest:'f'.repeat(64)},
    {view:'all',sort:'oldest',limit:7,roleId:'role-special',sourceJobId:'workable:job:exact',status:'current',
      query:'a "quoted" value \\ path',chip:'noHistory',after:{primary:'2026-09-09T10:00:00Z',secondary:'2026-09-09',key:'opaque:key'}},
    {applicationId:'22222222-2222-4222-8222-222222222222',rowDigest:'e'.repeat(64)},
    {applicationIds:['22222222-2222-4222-8222-222222222222'],requests:[{requestId:'opaque-request',decisionRevision:4}]},
  ];
  await read(async client=>{for(const request of requests){
    const row=(await client.query('SELECT $1::jsonb AS value',[JSON.stringify(request)])).rows[0];
    assert.deepEqual(row.value,request);
  }});
});

run('text is never guessed as JSON and other scalar casts preserve pg-compatible semantics',async()=>{
  await read(async client=>{
    const value='{"looks":"json"}';
    const row=(await client.query('SELECT $1::text AS text,$2::uuid::text AS id,$3::bigint::text AS revision,$4::integer AS count,$5::boolean AS enabled',
      [value,'22222222-2222-4222-8222-222222222222','9007199254740993',7,false])).rows[0];
    assert.deepEqual(row,{text:value,id:'22222222-2222-4222-8222-222222222222',revision:'9007199254740993',count:7,enabled:false});
    for(const input of [null,true,['a',2],{nested:{value:'Résumé 🛰️'}},'literal JSON string']){
      assert.deepEqual((await client.query('SELECT $1::jsonb AS value',[JSON.stringify(input)])).rows[0].value,input);
    }
  });
});

run('malformed serialized JSON is refused and the connection retains read-only rollback behavior',async()=>{
  await assert.rejects(read(client=>client.query('SELECT $1::jsonb AS value',['{"broken":'])),error=>error.code==='22P02');
  await read(async client=>{
    const flags=(await client.query("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation")).rows[0];
    assert.deepEqual(flags,{readonly:'on',isolation:'repeatable read'});
  });
});
