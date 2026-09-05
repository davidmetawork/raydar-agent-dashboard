import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const MARKER='raydar-submissions-rebuild-local-v1';
export const STATE_ROOT=resolve(homedir(),'.raydar/submissions-rebuild');
export function assertPreviewDatabase(value,marker) {
  let url; try { url=new URL(value); } catch { throw new Error('An explicit isolated preview database URL is required.'); }
  if(marker!==MARKER || !['postgres:','postgresql:'].includes(url.protocol) || url.hostname!=='127.0.0.1'
    || url.port!=='55439' || url.username!=='submissions_dev' || url.pathname!=='/submissions_preview' || url.search || url.hash) {
    throw new Error('Preview startup/reset refused: database must be the dedicated loopback preview database on port 55439.');
  }
  return url.href;
}
export async function previewConfig(input=process.env) {
  const databaseUrl=assertPreviewDatabase(input.SUBMISSIONS_PREVIEW_DATABASE_URL,input.SUBMISSIONS_PREVIEW_MARKER);
  await mkdir(STATE_ROOT,{recursive:true,mode:0o700});
  if((await lstat(STATE_ROOT)).isSymbolicLink()) throw new Error('Preview state directory cannot be a symbolic link.');
  await chmod(STATE_ROOT,0o700);
  const path=resolve(STATE_ROOT,'preview-keys.json');
  let keys;
  try { if((await lstat(path)).isSymbolicLink()) throw new Error('Preview keys cannot be a symbolic link.'); await chmod(path,0o600); keys=JSON.parse(await readFile(path,'utf8')); }
  catch(error) {
    if(error.code!=='ENOENT') throw error;
    keys={encryption:randomBytes(32).toString('base64url'),session:randomBytes(40).toString('base64url'),ingest:randomBytes(40).toString('base64url'),download:randomBytes(40).toString('base64url')};
    await writeFile(path,JSON.stringify(keys),{mode:0o600,flag:'wx'});
  }
  if(Object.values(keys).some(value=>typeof value!=='string'||value.length<32)) throw new Error('Preview keys are invalid.');
  const env={SUBMISSIONS_V2_DATABASE_URL:databaseUrl,SUBMISSIONS_V2_ENCRYPTION_KEY:keys.encryption,
    SUBMISSIONS_V2_DOWNLOAD_SECRET:keys.download,SUBMISSIONS_V2_UPLOAD_SECRET:keys.download,
    SUBMISSIONS_V2_RETENTION_HMAC_KEY:keys.download,SUBMISSIONS_V2_INGEST_KEY:keys.ingest,
    SUBMISSIONS_V2_UI_ENABLED:'true',SUBMISSIONS_V2_INGESTION_ENABLED:'true',SUBMISSIONS_V2_GENERATION_ENABLED:'true',
    SUBMISSIONS_V2_MASTER_INBOX_ENABLED:'true',SUBMISSIONS_V2_CURATED_ENABLED:'true',
    SUBMISSIONS_V2_SLACK_CHANNEL_ID:'C0123456789'};
  return {marker:MARKER,databaseUrl,stateRoot:STATE_ROOT,port:4525,origin:'http://127.0.0.1:4525',keys,env};
}
export function secretEqual(left,right) {
  const a=Buffer.from(String(left||'')),b=Buffer.from(String(right||''));
  return a.length===b.length && timingSafeEqual(a,b);
}
export function deniedNetwork(url) {
  throw Object.assign(new Error('The test environment blocked an external provider request.'),{code:'preview_network_denied',retryable:false});
}
