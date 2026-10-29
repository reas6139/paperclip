'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'paperclip-heartbeat-proof-'));
const vault=path.join(root,'vault'),map=path.join(vault,'01 - Graphify Code Map');
fs.mkdirSync(map,{recursive:true});
const note='# Paperclip memory connection canary\n\nTest marker: ECOSYSTEM_MEMORY_CANARY_20261009_A\n';
const filename='07 - Paperclip Memory Canary.md';
fs.writeFileSync(path.join(vault,filename),note);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const manifest={schema:'ecosystem-memory-snapshot-v1',status:'UNSHARED_LOCAL_CANDIDATE',sourceCommitVerified:false,items:[
  {scope:'root',name:filename,sha256:sha(note),bytes:Buffer.byteLength(note),shareClass:'synthetic',packedFile:'vault/'+filename}
],shared:false,verifiedByCloudAgent:false};
const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(root,'manifest.json'),manifestBytes);
let listener,baseURL;
before(async()=>{
  listener=http.createServer((req,res)=>{
    const auth=req.headers.authorization==='Bearer test-token';
    if(req.url!=='/api/agents/me'||!auth){res.writeHead(401,{'content-type':'application/json'});res.end('{}');return}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'test-agent',companyId:'test-company'}));
  });
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  baseURL='http://127.0.0.1:'+listener.address().port;
});
after(async()=>{
  await new Promise(resolve=>listener.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
});
const base=()=>({
 ...process.env,
 PAPERCLIP_AGENT_ID:'test-agent',PAPERCLIP_COMPANY_ID:'test-company',PAPERCLIP_RUN_ID:'run-example',PAPERCLIP_TASK_ID:'issue-example',
 PAPERCLIP_API_URL:baseURL,PAPERCLIP_API_KEY:'test-token',
 ECOSYSTEM_MEMORY_VAULT_DIR:vault,ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256:sha(manifestBytes)
});
function invoke(override={}){
  return new Promise(resolve=>{
    const child=cp.spawn(process.execPath,[path.join(__dirname,'heartbeat-canary-proof.cjs')],{
      env:{...base(),...override},stdio:['ignore','pipe','pipe'],windowsHide:true
    });
    let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill(),6000);
    child.stdout.on('data',x=>stdout+=x.toString());
    child.stderr.on('data',x=>stderr+=x.toString());
    child.on('close',code=>{clearTimeout(timer);let body;try{body=JSON.parse(code===0?stdout:stderr)}catch{body={parseError:true}}resolve({code,body,stdout,stderr})});
  });
}
test('mock controller authentication plus real pinned reader yields explicitly limited receipt',async()=>{
  const r=await invoke();
  assert.equal(r.code,0);
  assert.equal(r.body.level,'PAPERCLIP_API_AUTH_AND_LOCAL_CANARY_READ');
  assert.equal(r.body.controlPlaneIdentityChecked,true);
  assert.equal(r.body.paperclipRunOriginIndependentlyVerified,false);
  assert.equal(r.body.externallyDurableReceipt,false);
  assert.equal(r.body.noteSha256,sha(note));
  assert.equal(r.body.agentId,'test-agent');assert.equal(r.body.companyId,'test-company');
});
test('missing or invalid agent bearer credential fails closed',async()=>{
  for(const token of ['', 'bad-token'])assert.notEqual((await invoke({PAPERCLIP_API_KEY:token})).code,0);
});
test('wrong agent identity or company fails closed',async()=>{
  assert.notEqual((await invoke({PAPERCLIP_AGENT_ID:'other'})).code,0);
  assert.notEqual((await invoke({PAPERCLIP_COMPANY_ID:'other'})).code,0);
});
test('run ID and task ID are required',async()=>{
  assert.notEqual((await invoke({PAPERCLIP_TASK_ID:''})).code,0);
  assert.notEqual((await invoke({PAPERCLIP_RUN_ID:''})).code,0);
});
test('missing and incorrect snapshot pins fail closed',async()=>{
  assert.notEqual((await invoke({ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256:''})).code,0);
  assert.notEqual((await invoke({ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256:'0'.repeat(64)})).code,0);
});
test('wrong marker fails closed',async()=>{
  assert.notEqual((await invoke({ECOSYSTEM_MEMORY_CANARY_MARKER:'DOES_NOT_MATCH_20261009'})).code,0);
});
test('no remote arbitrary HTTP host without an explicit internal trusted flag',async()=>{
  assert.notEqual((await invoke({PAPERCLIP_API_URL:'http://example.com'})).code,0);
});
test('reader tampering is refused even after successful API auth',async()=>{
  fs.appendFileSync(path.join(vault,filename),'Tampered');
  const r=await invoke();
  assert.notEqual(r.code,0);
  assert.match(r.body.error,/SNAPSHOT_INTEGRITY/);
});
