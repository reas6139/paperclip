import test from "node:test";
import assert from "node:assert/strict";
import {importHandoff,validateHandoff,normalizePrivateOrigin,main} from "./import.mjs";
const COMPANY="11111111-1111-4111-8111-111111111111";
const ORIGIN="http://paperclip-cloud-controller.railway.internal:3100";
const KEY="scoped-test-only-key-value-1234567890";
const one={id:"external-first-step",title:"Make controller ownership secure",description:"Require actual private owner session and deny unauthenticated access.",priority:1,requires_owner:true,acceptance:["Authenticated owner successfully proves admin access"]};
const two={id:"external-second-step",title:"Prove independent issue checkout",description:"Use only a real scoped Paperclip agent and exclusive checkout token.",priority:2,requires_owner:false,depends_on:[one.id],acceptance:["Agent checks out only one real task with conflict denied"]};
const manifest={schema:"paperclip-external-handoff-v1",state:"AWAITING_AUTHENTICATED_NATIVE_PAPERCLIP_IMPORT",tasks:[two,one]};
const opts={manifest,apiOrigin:ORIGIN,approvedOrigin:ORIGIN,companyId:COMPANY,apiKey:KEY,apply:true};
function ok(data,status=200){return {ok:status>=200&&status<300,status,json:async()=>data};}

test("dry run sorts and does not touch credentials/network",async()=>{
  let calls=0;
  const v=await importHandoff({manifest,fetcher:async()=>{calls++;throw Error("network forbidden");}});
  assert.equal(v.mode,"DRY_RUN_NO_NETWORK");
  assert.deepEqual(v.tasks.map(x=>x.id),[one.id,two.id]);assert.equal(calls,0);
});

test("native backlog import is unassigned and carries review gates",async()=>{
  let calls=[],n=0;
  const fetcher=async(url,request)=>{
    calls.push({url,request});
    if(request.method==="GET")return ok([]);
    const body=JSON.parse(request.body);n++;
    assert.equal(body.status,"backlog");
    assert.equal(body.assigneeAgentId,undefined);
    assert.ok(body.description.includes("proof required"));
    assert.ok(body.description.includes("paperclip-handoff-key"));
    return ok({id:`${n.toString().padStart(8,"0")}-1111-4111-8111-111111111111`,...body});
  };
  const r=await importHandoff({...opts,fetcher});
  assert.deepEqual(r,{mode:"IMPORTED_AS_UNASSIGNED_BACKLOG",created:2,reused:0,total:2});
  assert.equal(calls.filter(c=>c.request.method==="POST").length,2);
  assert.ok(calls.every(c=>c.request.headers.Authorization===`Bearer ${KEY}`));
  assert.ok(calls.every(c=>c.url.startsWith(ORIGIN+"/api/")));
  assert.ok(calls.every(c=>c.request.redirect==="error"));
});

test("repeat run does not duplicate issues already carrying exact receipt marker",async()=>{
 let posts=0;
 const fetcher=async(url,req)=>req.method==="GET" ? ok([
  {id:"11111111-1111-4111-8111-111111111111",title:one.title,status:"backlog",description:"paperclip-handoff-key: paperclip-external-handoff-v1:external-first-step"},
  {id:"22222222-2222-4222-8222-222222222222",title:two.title,status:"todo",description:"paperclip-handoff-key: paperclip-external-handoff-v1:external-second-step"}
 ]) : (posts++,ok({}));
 const r=await importHandoff({...opts,fetcher});
 assert.equal(r.created,0);assert.equal(r.reused,2);assert.equal(posts,0);
});

test("401 and 409 fail closed before any later writes",async()=>{
 for(const status of [401,403,409,429]){
  let calls=0;
  const fetcher=async()=>{calls++;return ok({},status)};
  await assert.rejects(()=>importHandoff({...opts,fetcher}),/AUTHORIZATION_REQUIRED|CONFLICT_RECONCILE_FIRST|RATE_LIMITED_STOP/);
  assert.equal(calls,1);
 }
});

test("refuse host swap, insecure internet, credentials in URLs, or unknown company IDs",async()=>{
 for(const url of ["http://evil.example:3100","https://paperclip-cloud-controller.railway.internal:3100","http://user:secret@paperclip-cloud-controller.railway.internal:3100","http://paperclip-cloud-controller.railway.internal:3101"]){
  assert.throws(()=>normalizePrivateOrigin(url),/PRIVATE_NETWORK_ONLY/);
 }
 await assert.rejects(()=>importHandoff({...opts,approvedOrigin:"http://different.railway.internal:3100"}),/ORIGIN_NOT_APPROVED/);
 await assert.rejects(()=>importHandoff({...opts,companyId:"not-a-company"}),/CREDENTIAL_REQUIRED/);
});

test("reject malformed, duplicated, cyclic, out-of-order, or unexpectedly large manifests",()=>{
 assert.throws(()=>validateHandoff({...manifest,tasks:[one,one]}),/TASK_INVALID/);
 assert.throws(()=>validateHandoff({...manifest,tasks:[{...one,depends_on:[two.id]},two]}),/DEPENDENCY_INVALID/);
 assert.throws(()=>validateHandoff({...manifest,tasks:[]}),/MANIFEST_INVALID/);
 assert.throws(()=>validateHandoff({...manifest,tasks:[{...one,title:"x"}]}),/TASK_INVALID/);
});

test("malformed issue list or creation receipt cannot be counted as transfer",async()=>{
 await assert.rejects(()=>importHandoff({...opts,fetcher:async()=>ok({items:[]})}),/LIST_INVALID/);
 await assert.rejects(()=>importHandoff({...opts,fetcher:async(_u,r)=>r.method==="GET"?ok([]):ok({id:"not-a-uuid"})}),/CREATE_RECEIPT_INVALID/);
});


test("stale or forged import receipts fail closed instead of silently skipping work",async()=>{
 for(const invalid of [
  {id:"bad-id",title:one.title,status:"backlog"},
  {id:COMPANY,title:"Unexpected privileged operation",status:"backlog"},
  {id:COMPANY,title:one.title,status:"completed"},
 ]) {
   let posts=0;
   const fetcher=async(_url,req)=>req.method==="GET" ? ok([{...invalid,description:"paperclip-handoff-key: paperclip-external-handoff-v1:external-first-step"}]) : (posts++,ok({}));
   await assert.rejects(()=>importHandoff({...opts,fetcher}),/IMPORT_RECEIPT_CONFLICT/);
   assert.equal(posts,0);
 }
});

test("duplicate markers fail closed without making new issues",async()=>{
 let posts=0;
 const duplicate={id:COMPANY,title:one.title,status:"backlog",description:"paperclip-handoff-key: paperclip-external-handoff-v1:external-first-step"};
 const fetcher=async(_url,req)=>req.method==="GET" ? ok([duplicate,{...duplicate,id:"22222222-2222-4222-8222-222222222222"}]) : (posts++,ok({}));
 await assert.rejects(()=>importHandoff({...opts,fetcher}),/DUPLICATE_IMPORT_REQUIRES_REVIEW/);
 assert.equal(posts,0);
});

test("owner approval required for any apply and auth never echoes tokens",async()=>{
 await assert.rejects(()=>main({PAPERCLIP_EXTERNAL_HANDOFF_V1:JSON.stringify(manifest)},["--apply"]),/OWNER_IMPORT_APPROVAL_REQUIRED/);
 await assert.rejects(()=>main({PAPERCLIP_EXTERNAL_HANDOFF_V1:"bad"},[]),/MANIFEST_INVALID_JSON/);
 assert.ok(!JSON.stringify((await importHandoff({manifest}))).includes(KEY));
});
