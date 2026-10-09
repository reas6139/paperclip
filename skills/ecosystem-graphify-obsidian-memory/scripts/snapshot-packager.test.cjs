'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'paperclip-snapshot-fixture-'));
const vault=path.join(root,'vault'),map=path.join(vault,'01 - Graphify Code Map'),outRoot=path.join(root,'out');
fs.mkdirSync(map,{recursive:true});fs.mkdirSync(outRoot);
fs.writeFileSync(path.join(vault,'Project Goals.md'),'# Example goals\nA safe dummy project.\n');
fs.writeFileSync(path.join(map,'exampleSymbol.md'),'---\nsource_file: src/example.ts\n---\n# exampleSymbol\n');
const allowlist=path.join(root,'allowlist.json'),cli=path.join(__dirname,'snapshot-packager.cjs');
function save(notes){fs.writeFileSync(allowlist,JSON.stringify({version:1,notes}));}
const synthetic={scope:'root',name:'Project Goals.md',shareClass:'synthetic',reviewed:true};
const publicNote={scope:'graph',name:'exampleSymbol.md',shareClass:'approved-public',reviewed:true};
function run(args=[]){
  const p=cp.spawnSync(process.execPath,[cli,'--vault',vault,'--allowlist',allowlist,...args],{
    encoding:'utf8',timeout:8000,maxBuffer:100000});
  return {status:p.status,body:JSON.parse(p.status===0?p.stdout:p.stderr)};
}
after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('dry-run is deterministic, makes no candidate and does not upload',()=>{
  save([synthetic,publicNote]);const target=path.join(outRoot,'dry-run');
  const a=run(['--out',target]),b=run(['--out',target]);
  assert.equal(a.status,0);assert.deepEqual(a.body,b.body);
  assert.equal(a.body.files,2);assert.equal(a.body.written,false);
  assert.equal(a.body.uploaded,false);assert.equal(fs.existsSync(target),false);
});
test('explicit local --apply creates hash-verifiable versioned manifest',()=>{
  save([publicNote,synthetic]);const target=path.join(outRoot,'candidate-1');
  const r=run(['--out',target,'--apply']);assert.equal(r.status,0);
  assert.equal(r.body.shared,false);assert.equal(r.body.uploaded,false);
  const m=JSON.parse(fs.readFileSync(path.join(target,'manifest.json'),'utf8'));
  assert.equal(m.status,'UNSHARED_LOCAL_CANDIDATE');
  assert.equal(m.sourceCommitVerified,false);assert.equal(m.verifiedByCloudAgent,false);
  assert.equal(m.items.length,2);
  for(const item of m.items){
    const data=fs.readFileSync(path.join(target,item.packedFile));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'),item.sha256);
  }
});
test('existing output never overwritten',()=>{
  save([synthetic]);assert.equal(run(['--out',path.join(outRoot,'candidate-1'),'--apply']).status,1);
  assert.equal(fs.existsSync(path.join(outRoot,'candidate-1','manifest.json')),true);
});
test('internal or unreviewed entries blocked even in dry-run',()=>{
  for(const e of [{...synthetic,shareClass:'internal'},{...synthetic,reviewed:false}]){
    save([e]);assert.equal(run().status,1);
  }
});
test('traversal and nested paths blocked',()=>{
  for(const n of ['../secret.md','..\\secret.md','.hidden.md','sub/notes.md','file:ads.md']){
    save([{...synthetic,name:n}]);assert.equal(run().status,1,n);
  }
});
test('secret pattern in note blocks all candidate generation',()=>{
  fs.writeFileSync(path.join(vault,'Token Note.md'),'# Example\npassword=moreThanEightChars\n');
  save([{...synthetic,name:'Token Note.md'}]);assert.equal(run().status,1);
  assert.equal(fs.existsSync(path.join(outRoot,'denied-secret')),false);
  assert.equal(run(['--out',path.join(outRoot,'denied-secret'),'--apply']).status,1);
  assert.equal(fs.existsSync(path.join(outRoot,'denied-secret')),false);
});
test('symlinked note cannot be packaged',()=>{
  const dest=path.join(root,'elsewhere.md');fs.writeFileSync(dest,'# external');
  let allowed=true;try{fs.symlinkSync(dest,path.join(vault,'outside.md'),'file')}catch{allowed=false;}
  if(allowed){save([{...synthetic,name:'outside.md'}]);assert.equal(run().status,1);}
});
test('output inside source vault prohibited; no new files written',()=>{
  save([synthetic]);const target=path.join(vault,'candidate-not-allowed');
  assert.equal(run(['--out',target,'--apply']).status,1);
  assert.equal(fs.existsSync(target),false);
});
test('duplicate notes and empty allowlist rejected',()=>{
  save([synthetic,synthetic]);assert.equal(run().status,1);
  save([]);assert.equal(run().status,1);
});

test('packed allowlisted vault is readable by the separate bridge process without cloud access',()=>{
  save([synthetic,publicNote]);const target=path.join(outRoot,'roundtrip');
  assert.equal(run(['--out',target,'--apply']).status,0);
  const bridge=path.join(__dirname,'memory-readonly.cjs');
  const pin=crypto.createHash('sha256').update(fs.readFileSync(path.join(target,'manifest.json'))).digest('hex');
  const env={...process.env,ECOSYSTEM_MEMORY_VAULT_DIR:path.join(target,'vault'),ECOSYSTEM_MEMORY_GRAPH_FILE:'',ECOSYSTEM_MEMORY_SOURCE_REPO:'',ECOSYSTEM_MEMORY_CLOUD_MODE:'1',ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256:pin};
  const invoke=(args)=>{const r=cp.spawnSync(process.execPath,[bridge,...args],{env,encoding:'utf8',timeout:5000});return {status:r.status,payload:JSON.parse(r.status===0?r.stdout:r.stderr)};};
  const status=invoke(['status']);assert.equal(status.status,0);
  assert.equal(status.payload.topLevelNotes,1);assert.equal(status.payload.graphNotes,1);
  assert.equal(status.payload.cloudAgentAuthenticated,false);
  assert.equal(status.payload.snapshot.state,'pinned-content-verified');
  assert.deepEqual(invoke(['search','exampleSymbol']).payload.graphMatches,['exampleSymbol.md']);
  assert.match(invoke(['read-index','Project Goals.md']).payload.content,/safe dummy project/);
  assert.equal(invoke(['query','architecture']).status,1);
});

test('staged vault is blocked without out-of-band SHA pin, and tampering fails closed',()=>{
  save([synthetic]);const target=path.join(outRoot,'tamper-case');
  assert.equal(run(['--out',target,'--apply']).status,0);
  const bridge=path.join(__dirname,'memory-readonly.cjs'),snapshot=path.join(target,'vault');
  const base={...process.env,ECOSYSTEM_MEMORY_VAULT_DIR:snapshot,ECOSYSTEM_MEMORY_GRAPH_FILE:'',ECOSYSTEM_MEMORY_CLOUD_MODE:'1'};
  const invoke=(env)=>cp.spawnSync(process.execPath,[bridge,'status'],{env:{...base,...env},encoding:'utf8',timeout:4000});
  assert.notEqual(invoke({ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256:''}).status,0);
  const pin=crypto.createHash('sha256').update(fs.readFileSync(path.join(target,'manifest.json'))).digest('hex');
  assert.equal(invoke({ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256:pin}).status,0);
  assert.notEqual(invoke({ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256:'0'.repeat(64)}).status,0);
  fs.appendFileSync(path.join(snapshot,'Project Goals.md'),'\nTampered');
  assert.notEqual(invoke({ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256:pin}).status,0);
});
test('unreviewed extra Markdown content makes pinned snapshot unavailable',()=>{
  save([synthetic]);const target=path.join(outRoot,'extra-case');
  assert.equal(run(['--out',target,'--apply']).status,0);
  const pin=crypto.createHash('sha256').update(fs.readFileSync(path.join(target,'manifest.json'))).digest('hex');
  fs.writeFileSync(path.join(target,'vault','unreviewed.md'),'# unexpected');
  const bridge=path.join(__dirname,'memory-readonly.cjs');
  const r=cp.spawnSync(process.execPath,[bridge,'list'],{encoding:'utf8',timeout:4000,env:{
    ...process.env,ECOSYSTEM_MEMORY_VAULT_DIR:path.join(target,'vault'),
    ECOSYSTEM_MEMORY_CLOUD_MODE:'1',ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256:pin
  }});
  assert.notEqual(r.status,0);
});
