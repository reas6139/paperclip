#!/usr/bin/env node
'use strict';
// Read-only, on-demand memory. No network, daemon, or implicit host access.
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const MAX_NOTE_BYTES=65536, MAX_OUTPUT_CHARS=12000, MAX_RESULTS=20;
const commands=new Set(['status','list','search','read','read-index','query']);
const [verb,...input]=process.argv.slice(2);
function error(message){process.stderr.write(JSON.stringify({ok:false,error:message})+'\n');process.exitCode=1;}
function root(folder){
  if(!folder||!path.isAbsolute(folder))throw Error('An explicit absolute vault path is required');
  if(!fs.existsSync(folder))throw Error('Vault path is unavailable');
  const s=fs.lstatSync(folder);
  if(!s.isDirectory()||s.isSymbolicLink())throw Error('Vault must be a real directory');
  return fs.realpathSync(folder);
}
function noteName(name){
  if(!name||name.length>180||!name.endsWith('.md')||name.startsWith('.')||name.includes('..')||
    /[/\\:\x00-\x1f]/.test(name)||path.basename(name)!==name||path.win32.basename(name)!==name)
    throw Error('Only a simple Markdown filename is allowed');
  return name;
}
function read(rootDir,name){
  noteName(name);
  const full=path.join(rootDir,name),s=fs.lstatSync(full);
  if(!s.isFile()||s.isSymbolicLink()||s.size>MAX_NOTE_BYTES)throw Error('Not a regular note within size limit');
  if(path.dirname(fs.realpathSync(full))!==rootDir)throw Error('Note is outside permitted directory');
  return fs.readFileSync(full,'utf8').slice(0,MAX_OUTPUT_CHARS);
}
function names(dir){
  return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&!e.isSymbolicLink()&&e.name.endsWith('.md')&&!e.name.startsWith('.')).map(e=>e.name).sort();
}
function git(repo,args){
  if(!repo||!path.isAbsolute(repo)||!fs.existsSync(repo))return null;
  const r=cp.spawnSync('git',['-C',repo,...args],{shell:false,encoding:'utf8',timeout:2500,maxBuffer:100000,windowsHide:true});
  return r.status===0?(r.stdout||'').trim():null;
}
function freshness(graph,repo){
  if(!graph||!fs.existsSync(graph))return {status:'no-graph'};
  const report=path.join(path.dirname(graph),'GRAPH_REPORT.md');
  const txt=fs.existsSync(report)?fs.readFileSync(report,'utf8').slice(0,30000):'';
  const commit=(txt.match(/Built from commit:\s*\x60?([a-f0-9]{7,40})/i)||[])[1]||null;
  const head=git(repo,['rev-parse','HEAD']),dirty=git(repo,['status','--porcelain']);
  return {status:commit&&head&&head.startsWith(commit)&&dirty===''?'matching-clean-checkout':'snapshot-unverified',
    graphSourceCommit:commit,repoHead:head,workingTreeDirty:dirty===null?null:dirty!==''};
}
function verifySnapshot(vault,map){
  const manifestFile=path.join(path.dirname(vault),'manifest.json');
  const pin=process.env.ECOSYSTEM_MEMORY_EXPECTED_MANIFEST_SHA256||'';
  const cloudMode=process.env.ECOSYSTEM_MEMORY_CLOUD_MODE==='1';
  if(!fs.existsSync(manifestFile)){
    if(pin||cloudMode)throw Error('Pinned snapshot manifest required in cloud mode');
    return {state:'local-unpinned',approvedForCloud:false};
  }
  if(!/^[a-f0-9]{64}$/i.test(pin))throw Error('Explicit trusted snapshot manifest SHA-256 pin required');
  const s=fs.lstatSync(manifestFile);
  if(!s.isFile()||s.isSymbolicLink()||s.size>150000)throw Error('Invalid manifest file');
  const raw=fs.readFileSync(manifestFile),actual=require('node:crypto').createHash('sha256').update(raw).digest('hex');
  if(actual!==pin.toLowerCase())throw Error('Snapshot manifest digest mismatch');
  const m=JSON.parse(raw.toString('utf8'));
  if(m.schema!=='ecosystem-memory-snapshot-v1'||!Array.isArray(m.items)||m.items.length<1||m.items.length>200)throw Error('Invalid snapshot schema');
  if(m.status!=='UNSHARED_LOCAL_CANDIDATE'||m.shared!==false||m.verifiedByCloudAgent!==false)throw Error('Unrecognized snapshot state');
  const seen=new Set();
  for(const item of m.items){
    if(!item||!['root','graph'].includes(item.scope)||!['synthetic','approved-public'].includes(item.shareClass)||
      typeof item.bytes!=='number'||item.bytes<0||item.bytes>65536||!(/^[a-f0-9]{64}$/.test(item.sha256)))throw Error('Invalid snapshot entry');
    noteName(item.name);
    const rel='vault/'+(item.scope==='graph'?'01 - Graphify Code Map/':'')+item.name;
    if(item.packedFile!==rel||seen.has(rel))throw Error('Noncanonical/duplicate snapshot entry');
    seen.add(rel);
    const origin=item.scope==='graph'?map:vault;
    const loc=path.join(origin,item.name),st=fs.lstatSync(loc);
    if(!st.isFile()||st.isSymbolicLink()||st.size!==item.bytes||path.dirname(fs.realpathSync(loc))!==origin)throw Error('Snapshot entry file mismatch');
    const sha=require('node:crypto').createHash('sha256').update(fs.readFileSync(loc)).digest('hex');
    if(sha!==item.sha256)throw Error('Snapshot content digest mismatch');
  }
  const present=[...names(vault).map(n=>'vault/'+n),...names(map).map(n=>'vault/01 - Graphify Code Map/'+n)];
  if(present.length!==seen.size||present.some(x=>!seen.has(x)))throw Error('Snapshot contains unreviewed extra notes');
  return {state:'pinned-content-verified',approvedForCloud:false,manifestSha256:actual,notes:seen.size};
}
let snapshotInfo=null;
function send(data){process.stdout.write(JSON.stringify({ok:true,snapshot:snapshotInfo,...data})+'\n');}
try{
  if(!commands.has(verb))throw Error('Use: status | list | search <term> | read <name.md> | read-index <name.md> | query <question>');
  const vault=root(process.env.ECOSYSTEM_MEMORY_VAULT_DIR),map=root(path.join(vault,'01 - Graphify Code Map'));
  const graph=process.env.ECOSYSTEM_MEMORY_GRAPH_FILE||'',repo=process.env.ECOSYSTEM_MEMORY_SOURCE_REPO||'';
  snapshotInfo=verifySnapshot(vault,map);
  if(verb==='status'){
    const valid=graph&&fs.existsSync(graph)&&fs.lstatSync(graph).isFile()&&!fs.lstatSync(graph).isSymbolicLink();
    send({bridge:'local-readonly',vaultMounted:true,topLevelNotes:names(vault).length,graphNotes:names(map).length,
      graphBytes:valid?fs.statSync(graph).size:null,...freshness(valid?graph:'',repo),cloudAgentAuthenticated:false});
  }else if(verb==='list'){
    send({notes:names(vault).slice(0,100),source:'Obsidian local vault'});
  }else if(verb==='read'||verb==='read-index'){
    const name=input.join(' ');send({name,content:read(verb==='read'?map:vault,name),source:'Obsidian snapshot; verify original source'});
  }else if(verb==='search'){
    const term=input.join(' ').trim().toLocaleLowerCase();
    if(term.length<3||term.length>120)throw Error('Search must be between 3 and 120 characters');
    const graphMatches=names(map).filter(n=>n.toLocaleLowerCase().includes(term)).slice(0,MAX_RESULTS);
    const indexMatches=names(vault).filter(n=>n.toLocaleLowerCase().includes(term)||
      (fs.statSync(path.join(vault,n)).size<=MAX_NOTE_BYTES&&read(vault,n).toLocaleLowerCase().includes(term))).slice(0,MAX_RESULTS);
    send({term,graphMatches,indexMatches,freshness:freshness(graph,repo).status});
  }else if(verb==='query'){
    const question=input.join(' ').trim();
    if(question.length<3||question.length>220)throw Error('Query must be between 3 and 220 characters');
    if(!graph||!path.isAbsolute(graph)||!fs.existsSync(graph))throw Error('Graph file not mounted');
    const stat=fs.lstatSync(graph);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>50000000)throw Error('Invalid graph file');
    const bin=process.env.ECOSYSTEM_GRAPHIFY_BIN||'graphify';
    const r=cp.spawnSync(bin,['query',question,'--graph',graph,'--budget','450'],{
      encoding:'utf8',shell:false,timeout:8000,maxBuffer:250000,windowsHide:true});
    if(r.status!==0)throw Error('Graphify unavailable or failed (no speculative fallback)');
    send({question,answer:(r.stdout||'').slice(0,MAX_OUTPUT_CHARS),freshness:freshness(graph,repo),source:'Graphify-derived snapshot'});
  }
}catch(e){error(e instanceof Error?e.message:String(e));}
