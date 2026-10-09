#!/usr/bin/env node
'use strict';
// Opt-in, zero-write heartbeat proof. Exits nonzero until BOTH real API identity
// and an integrity-pinned canary read pass. Never publishes/marks a task done.
const cp=require('node:child_process'),path=require('node:path'),crypto=require('node:crypto');
const env=process.env;
function fail(reason){process.stderr.write(JSON.stringify({ok:false,error:reason})+'\n');process.exitCode=1;}
async function main(){
  const needed=['PAPERCLIP_AGENT_ID','PAPERCLIP_COMPANY_ID','PAPERCLIP_RUN_ID','PAPERCLIP_TASK_ID','PAPERCLIP_API_URL','PAPERCLIP_API_KEY','ECOSYSTEM_MEMORY_VAULT_DIR','ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256'];
  for(const key of needed)if(!env[key]||env[key].length>2048)throw Error('MISSING_OR_INVALID_'+key);
  if(!/^[a-f0-9]{64}$/i.test(env.ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256))throw Error('INVALID_MANIFEST_PIN');
  const parsed=new URL(env.PAPERCLIP_API_URL);
  if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.hash||parsed.search)throw Error('INVALID_API_URL');
  if(parsed.protocol==='http:' && !['localhost','127.0.0.1','::1'].includes(parsed.hostname) && !env.PAPERCLIP_INTERNAL_HTTP_TRUSTED)throw Error('UNTRUSTED_PLAINTEXT_API_URL');
  const controller=new URL('api/agents/me',parsed.href.replace(/\/+$/,'')+'/');
  const r=await fetch(controller,{method:'GET',headers:{Authorization:'Bearer '+env.PAPERCLIP_API_KEY,Accept:'application/json'},signal:AbortSignal.timeout(4500),redirect:'error'});
  if(r.status!==200)throw Error('PAPERCLIP_AGENT_AUTH_FAILED_'+r.status);
  const body=await r.json();
  const identity=body && typeof body==='object' && body.agent && typeof body.agent==='object'?body.agent:body;
  if(identity?.id!==env.PAPERCLIP_AGENT_ID || identity?.companyId!==env.PAPERCLIP_COMPANY_ID)throw Error('PAPERCLIP_AGENT_SCOPE_MISMATCH');
  const marker=env.ECOSYSTEM_MEMORY_CANARY_MARKER||'ECOSYSTEM_MEMORY_CANARY_20261009_A';
  if(!/^[A-Za-z0-9_-]{12,100}$/.test(marker))throw Error('INVALID_CANARY_MARKER');
  const reader=path.join(__dirname,'memory-readonly.cjs');
  const child=cp.spawnSync(process.execPath,[reader,'read-index','07 - Paperclip Memory Canary.md'],{
    shell:false,encoding:'utf8',timeout:5000,maxBuffer:40000,
    env:{...env,ECOSYSTEM_MEMORY_CLOUD_MODE:'1'},windowsHide:true
  });
  if(child.status!==0)throw Error('SNAPSHOT_INTEGRITY_OR_RETRIEVAL_FAILED');
  let parsedRead;try{parsedRead=JSON.parse(child.stdout)}catch{throw Error('INVALID_BRIDGE_RESPONSE')}
  if(!parsedRead?.ok||parsedRead.snapshot?.state!=='pinned-content-verified')throw Error('PINNED_SNAPSHOT_NOT_VERIFIED');
  if(typeof parsedRead.content!=='string'||!parsedRead.content.includes(marker))throw Error('CANARY_MARKER_MISMATCH');
  const digest=crypto.createHash('sha256').update(parsedRead.content).digest('hex');
  process.stdout.write(JSON.stringify({
    ok:true,
    level:'PAPERCLIP_API_AUTH_AND_LOCAL_CANARY_READ',
    agentId:identity.id,companyId:identity.companyId,
    runId:env.PAPERCLIP_RUN_ID,taskId:env.PAPERCLIP_TASK_ID,
    manifestSha256:parsedRead.snapshot.manifestSha256,
    noteSha256:digest,canaryMarker:marker,
    source:'read-index via integrity-pinned agent-local mounted snapshot',
    controlPlaneIdentityChecked:true,
    paperclipRunOriginIndependentlyVerified:false,
    externallyDurableReceipt:false,
    repeatedUnattendedCyclesVerified:false,
    productionDeploymentVerified:false
  })+'\n');
}
main().catch(e=>fail(String(e?.message||'ERROR').slice(0,180)));
