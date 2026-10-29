'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'paperclip-memory-test-'));
const map=path.join(root,'01 - Graphify Code Map');
fs.mkdirSync(map);
fs.writeFileSync(path.join(root,'00 - AI Ecosystem Memory Index.md'),'# Project Memory\nOwner approval required.');
fs.writeFileSync(path.join(map,'analyzeAndPersistFreelanceJob().md'),'---\nsource_file: src/lib/freelance/runtime.server.ts\n---\n# Node');
const entry=path.join(__dirname,'memory-readonly.cjs');
function run(args,env={}){
  const p=cp.spawnSync(process.execPath,[entry,...args],{
    encoding:'utf8',timeout:5000,maxBuffer:100000,
    env:{...process.env,ECOSYSTEM_MEMORY_VAULT_DIR:root,ECOSYSTEM_MEMORY_GRAPH_FILE:'',ECOSYSTEM_MEMORY_SOURCE_REPO:'',...env}
  });
  return {status:p.status,stdout:p.stdout,stderr:p.stderr,body:JSON.parse(p.status===0?p.stdout:p.stderr)};
}
after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('mount status is explicit; unavailable graph and no cloud authentication',()=>{
  const r=run(['status']);assert.equal(r.status,0);assert.equal(r.body.topLevelNotes,1);
  assert.equal(r.body.graphNotes,1);assert.equal(r.body.status,'no-graph');
  assert.equal(r.body.cloudAgentAuthenticated,false);
});
test('search finds both an index note and a source-linked code symbol',()=>{
  assert.deepEqual(run(['search','owner approval']).body.indexMatches,['00 - AI Ecosystem Memory Index.md']);
  assert.deepEqual(run(['search','FreelanceJob']).body.graphMatches,['analyzeAndPersistFreelanceJob().md']);
});
test('read and read-index return original note metadata',()=>{
  assert.match(run(['read-index','00 - AI Ecosystem Memory Index.md']).body.content,/Owner approval/);
  assert.match(run(['read','analyzeAndPersistFreelanceJob().md']).body.content,/source_file/);
});
test('traversal, hidden files, ADS and non-notes are blocked',()=>{
  for(const name of ['..\\secret.md','../secret.md','.obsidian.md','file.txt','file:ads.md']){
    const r=run(['read',name]);assert.equal(r.status,1,'Expected rejection for '+name);assert.equal(r.body.ok,false);
  }
});
test('symlinks out of the vault fail closed',()=>{
  const secret=path.join(root,'secrets-outside.txt');fs.writeFileSync(secret,'secret');
  const link=path.join(map,'escape.md');let supported=true;
  try{fs.symlinkSync(secret,link,'file')}catch{supported=false}
  if(supported)assert.equal(run(['read','escape.md']).status,1);
});
test('missing vault fails closed',()=>{
  assert.equal(run(['status'],{ECOSYSTEM_MEMORY_VAULT_DIR:path.join(root,'not-here')}).status,1);
});
test('missing graph fails without invoking a model or network',()=>{
  const r=run(['query','architecture']);assert.equal(r.status,1);
  assert.match(r.body.error,/Graph file not mounted/);
});
test('unrecognized commands and oversized input are rejected',()=>{
  assert.equal(run(['search','ab']).status,1);
  assert.equal(run(['query','x'.repeat(300)]).status,1);
  assert.equal(run(['modify','note']).status,1);
});
