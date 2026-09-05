import { createHash,randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve,sep } from 'node:path';

export function createLocalPrivateStorage(root) {
  const stateRoot=resolve(root),base=resolve(stateRoot,'private-objects');
  function path(key) {
    if(typeof key!=='string' || !key || key.includes('\\') || key.split('/').some(part=>part==='..'||part==='.') || key.startsWith('/')) throw new Error('Invalid private object key.');
    const target=resolve(base,key);
    if(!target.startsWith(base+sep)) throw new Error('Invalid private object path.');
    return target;
  }
  async function safeDirectory(directory,{create=false}={}) {
    if(create) {
      try {await mkdir(directory,{mode:0o700});}
      catch(error) {if(error?.code!=='EEXIST')throw error;}
    }
    const stat=await lstat(directory);
    if(stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Private test storage cannot use symbolic links.');
  }
  async function safePath(key,{createParent=false}={}) {
    const target=path(key);
    await safeDirectory(stateRoot);
    await safeDirectory(base,{create:createParent});
    let current=base;
    for(const part of key.split('/').slice(0,-1)) {
      if(!part)continue;
      current=resolve(current,part);
      await safeDirectory(current,{create:createParent});
    }
    return target;
  }
  async function readObject(key) {
    const target=await safePath(key),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const stat=await handle.stat();
      if(!stat.isFile())throw new Error('Private test object must be a regular file.');
      return await handle.readFile();
    } finally {await handle.close();}
  }
  return {
    async putPrivateObject(key,bytes,contentType) {
      const destination=await safePath(key,{createParent:true}),data=Buffer.from(bytes),temporary=`${destination}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        await handle.writeFile(data);
        await handle.close();handle=null;
        await safePath(key);
        await rename(temporary,destination);
      } catch(error) {
        await handle?.close().catch(()=>{});
        await unlink(temporary).catch(()=>{});
        throw error;
      }
      return {pathname:key,url:`private:${key}`,contentType,size:data.length};
    },
    async readPrivateObject(key) {
      let bytes;
      try { bytes=await readObject(key); }
      catch(error) {
        if(error?.code==='ENOENT') throw Object.assign(new Error('Private test object was not found.'),{code:'blob_not_found',status:404});
        throw error;
      }
      return {bytes,pathname:key,contentType:key.endsWith('.pdf')?'application/pdf':'application/octet-stream',digest:createHash('sha256').update(bytes).digest('hex')};
    },
    async inspectPrivateObject(key) {
      let bytes;
      try { bytes=await readObject(key); }
      catch(error) {
        if(error?.code==='ENOENT') throw Object.assign(new Error('Private test object was not found.'),{code:'blob_not_found',status:404});
        throw error;
      }
      return {size:bytes.length,pathname:key};
    },
    async deletePrivateObject(key) {
      let target;
      try {
        target=await safePath(key);
        const stat=await lstat(target);
        if(stat.isSymbolicLink() || !stat.isFile())throw new Error('Private test object must be a regular file.');
        await unlink(target);
      } catch(error) {if(error?.code!=='ENOENT')throw error;}
    },
    async createPresignedUpload() { throw Object.assign(new Error('Test upload is unavailable; use the synthetic candidate resume.'),{code:'preview_upload_disabled',status:422}); },
  };
}
