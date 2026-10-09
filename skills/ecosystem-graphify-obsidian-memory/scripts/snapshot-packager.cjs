#!/usr/bin/env node
'use strict';
// Offline candidate snapshot packager: explicit allowlist, no network, no implicit sharing.
// --apply writes ONLY to an operator-chosen local staging directory, never to cloud.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const flags=process.argv.slice(2);
function arg(name){const i=flags.indexOf(name);return i<0?'':flags[i+1];}
const apply=flags.includes('--apply');
function fail(message){process.stderr.write(JSON.stringify({ok:false,error:String(message)})+'\n');process.exitCode=1;}
function dir(p){if(!p||!path.isAbsolute(p)||!fs.existsSync(p))throw Error('Absolute existing directory required');const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('No linked/non-directory roots allowed');return fs.realpathSync(p);}
function file(p,limit){const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw Error('Unexpected/linked/oversized file');return fs.readFileSync(p);}
function name(s){if(typeof s!=='string'||s.length<4||s.length>180||!s.endsWith('.md')||s.includes('..')||s.startsWith('.')||/[/\\:\x00-\x1f]/.test(s)||path.basename(s)!==s||path.win32.basename(s)!==s)throw Error('Unsafe Markdown note name');return s;}
const bad=[
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{50,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{24,}/g,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
  /xox[baprs]-[A-Za-z0-9-]{15,}/g,
  /-----BEGIN CERTIFICATE-----/g,
  /(?:^|\n)\s*(?:password|api[_-]?key|secret|token|authorization)\s*[:=]\s*\S{8,}/gi,
];
function scan(text){return bad.some(r=>{r.lastIndex=0;return r.test(text)});}
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
try{
  const vault=dir(arg('--vault')),allow=arg('--allowlist'),out=arg('--out');
  if(!allow||!path.isAbsolute(allow))throw Error('Explicit allowlist path required');
  const acl=JSON.parse(file(allow,20000).toString('utf8'));
  if(acl.version!==1||!Array.isArray(acl.notes)||acl.notes.length===0||acl.notes.length>200)throw Error('Allowlist must contain 1-200 reviewed entries');
  const entries=[],seen=new Set();
  for(const item of acl.notes){
    if(!item||!['root','graph'].includes(item.scope)||!['synthetic','approved-public'].includes(item.shareClass)||item.reviewed!==true)throw Error('Only reviewed synthetic/approved-public notes allowed; internal vault material blocked');
    const n=name(item.name);
    const source=item.scope==='root'?vault:dir(path.join(vault,'01 - Graphify Code Map'));
    const sourcePath=path.join(source,n),txt=file(sourcePath,65536).toString('utf8');
    if(path.dirname(fs.realpathSync(sourcePath))!==source)throw Error('Escaping source path');
    if(scan(txt))throw Error('Candidate contains probable credential; output blocked');
    const key=item.scope+':'+n.toLowerCase();
    if(seen.has(key))throw Error('Duplicate allowlist entry');
    seen.add(key);
    entries.push({scope:item.scope,name:n,sha256:sha(Buffer.from(txt,'utf8')),bytes:Buffer.byteLength(txt,'utf8'),shareClass:item.shareClass,source:sourcePath,text:txt});
  }
  entries.sort((a,b)=>(a.scope+'/'+a.name).localeCompare(b.scope+'/'+b.name,'en'));
  const summary=entries.map(({scope,name,sha256,bytes,shareClass})=>({scope,name,sha256,bytes,shareClass}));
  if(!apply){process.stdout.write(JSON.stringify({ok:true,mode:'dry-run',files:summary.length,items:summary,uploaded:false,written:false,security:'heuristic screen only; content must be reviewed independently'})+'\n');process.exit(0);}
  if(!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Output must be an explicit, unused absolute directory');
  const parent=dir(path.dirname(out));if(parent===vault||parent.startsWith(vault+path.sep))throw Error('Output cannot be inside source vault');
  const dest=path.join(parent,path.basename(out));if(dest!==path.resolve(out))throw Error('Output path must be direct child of existing directory');
  fs.mkdirSync(dest,{recursive:false,mode:0o700});
  try {
    fs.mkdirSync(path.join(dest,'notes'));
    for(let i=0;i<entries.length;i++){
      const e=entries[i];
      fs.writeFileSync(path.join(dest,'notes',String(i).padStart(4,'0')+'.md'),e.text,{flag:'wx',mode:0o600});
    }
    const manifest={schema:'ecosystem-memory-snapshot-v1',status:'UNSHARED_LOCAL_CANDIDATE',sourceCommitVerified:false,items:summary.map((x,i)=>({...x,packedFile:'notes/'+String(i).padStart(4,'0')+'.md'})),shared:false,verifiedByCloudAgent:false};
    fs.writeFileSync(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    process.stdout.write(JSON.stringify({ok:true,mode:'local-only-candidate',files:entries.length,manifest:dest,uploaded:false,shared:false})+'\n');
  }catch(e){fs.rmSync(dest,{recursive:true,force:true});throw e;}
}catch(e){fail(e instanceof Error?e.message:String(e));}
