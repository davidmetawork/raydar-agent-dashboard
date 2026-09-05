import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertPreviewDatabase,MARKER,deniedNetwork} from '../submissions-preview/config.mjs';
import {createLocalPrivateStorage} from '../submissions-preview/storage.mjs';
import {finishPreviewStartup} from '../submissions-preview/server.mjs';

test('preview accepts only its exact local database and explicit marker',()=>{
  const valid='postgresql://submissions_dev@127.0.0.1:55439/submissions_preview';
  assert.equal(assertPreviewDatabase(valid,MARKER),valid);
  for(const value of [valid.replace('127.0.0.1','db.example.com'),valid.replace('55439','5432'),valid.replace('submissions_preview','production'),`${valid}?options=-csearch_path=public`,valid.replace('submissions_dev','postgres')])assert.throws(()=>assertPreviewDatabase(value,MARKER));
  assert.throws(()=>assertPreviewDatabase(valid,''));
  assert.throws(()=>deniedNetwork('https://example.com'),{code:'preview_network_denied'});
});
test('private local storage is binary-safe and rejects path escape',async()=>{
  const root=await mkdtemp(join(tmpdir(),'submissions-preview-'));
  try{
    const storage=createLocalPrivateStorage(root),bytes=Buffer.from([0,10,123,255]);
    await storage.putPrivateObject('test/document.pdf',bytes,'application/pdf');
    assert.deepEqual((await storage.readPrivateObject('test/document.pdf')).bytes,bytes);
    for(const key of ['../outside','/tmp/outside','nested/../../outside','nested\\..\\outside'])await assert.rejects(storage.readPrivateObject(key));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('private local storage rejects base, parent, and object symlinks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'submissions-preview-')),outside=await mkdtemp(join(tmpdir(),'submissions-preview-outside-'));
  try{
    const storage=createLocalPrivateStorage(root);
    await symlink(outside,join(root,'private-objects'),'dir');
    await assert.rejects(storage.putPrivateObject('escaped.pdf',Buffer.from('outside'),'application/pdf'),/symbolic links/);
    await rm(join(root,'private-objects'));
    await mkdir(join(root,'private-objects'),{mode:0o700});
    await symlink(outside,join(root,'private-objects','nested'),'dir');
    await assert.rejects(storage.putPrivateObject('nested/escaped.pdf',Buffer.from('outside'),'application/pdf'),/symbolic links/);
    await writeFile(join(outside,'secret.pdf'),'secret');
    await symlink(join(outside,'secret.pdf'),join(root,'private-objects','object.pdf'));
    await assert.rejects(storage.readPrivateObject('object.pdf'));
    await assert.rejects(storage.deletePrivateObject('object.pdf'),/regular file/);
    assert.equal(await readFile(join(outside,'secret.pdf'),'utf8'),'secret');
  }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('failed preview bind rolls back its initialized runtime and network guard',async()=>{
  const root=await mkdtemp(join(tmpdir(),'submissions-preview-startup-')),holder=createServer(),server=createServer();
  const nativeFetch=globalThis.fetch,guardedFetch=()=>{throw new Error('guarded');};
  let closes=0,starts=0;
  try{
    await new Promise((resolveListen,rejectListen)=>{holder.once('error',rejectListen);holder.listen(0,'127.0.0.1',resolveListen);});
    globalThis.fetch=guardedFetch;
    await assert.rejects(finishPreviewStartup({server,runtime:{start(){starts+=1;},async close(){closes+=1;}},config:{port:holder.address().port,stateRoot:root},nativeFetch}),{code:'EADDRINUSE'});
    assert.equal(starts,0);assert.equal(closes,1);assert.equal(server.listening,false);assert.equal(globalThis.fetch,nativeFetch);
  }finally{
    globalThis.fetch=nativeFetch;
    await new Promise(resolveClose=>holder.close(resolveClose));
    if(server.listening)await new Promise(resolveClose=>server.close(resolveClose));
    await rm(root,{recursive:true,force:true});
  }
});
