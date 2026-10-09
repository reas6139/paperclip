import { pathToFileURL } from "node:url";

export const MANIFEST_SCHEMA = "paperclip-external-handoff-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z0-9][a-z0-9-]{3,79}$/;
const MARKER = (key) => `paperclip-handoff-key: ${MANIFEST_SCHEMA}:${key}`;

export function validateHandoff(raw) {
  if (!raw || Array.isArray(raw) || typeof raw !== "object" ||
      raw.schema !== MANIFEST_SCHEMA ||
      raw.state !== "AWAITING_AUTHENTICATED_NATIVE_PAPERCLIP_IMPORT" ||
      !Array.isArray(raw.tasks) || raw.tasks.length < 1 || raw.tasks.length > 30) {
    throw Error("HANDOFF_MANIFEST_INVALID");
  }
  const byId = new Map();
  for (const task of raw.tasks) {
    if (!task || !KEY.test(task.id) || byId.has(task.id) ||
        typeof task.title !== "string" || task.title.length < 8 || task.title.length > 160 ||
        typeof task.description !== "string" || task.description.length < 20 || task.description.length > 5000 ||
        !Number.isInteger(task.priority) || task.priority < 1 || task.priority > 30 ||
        !Array.isArray(task.acceptance) || task.acceptance.length < 1 || task.acceptance.length > 12 ||
        !task.acceptance.every(x => typeof x === "string" && x.length >= 8 && x.length <= 800) ||
        ![true, false].includes(task.requires_owner) ||
        !Array.isArray(task.depends_on ?? []) ||
        !(task.depends_on ?? []).every(x => typeof x === "string" && KEY.test(x))) {
      throw Error("HANDOFF_TASK_INVALID");
    }
    byId.set(task.id, task);
  }
  for (const task of raw.tasks) for (const dep of task.depends_on ?? []) {
    if (!byId.has(dep) || dep === task.id || byId.get(dep).priority >= task.priority) {
      throw Error("HANDOFF_DEPENDENCY_INVALID");
    }
  }
  // Treat this as a finite, operator-approved IMPORT, not an autonomous scheduler.
  return [...raw.tasks].sort((a,b) => a.priority-b.priority || a.id.localeCompare(b.id));
}

export function normalizePrivateOrigin(input) {
  if (typeof input !== "string" || !input) throw Error("PAPERCLIP_PRIVATE_API_ORIGIN_REQUIRED");
  let url;
  try { url = new URL(input); } catch { throw Error("PAPERCLIP_API_URL_INVALID"); }
  if (url.protocol !== "http:" || !url.hostname.endsWith(".railway.internal") ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      url.port !== "3100") throw Error("PAPERCLIP_PRIVATE_NETWORK_ONLY");
  return url.origin;
}

function renderDescription(task) {
  const approval = task.requires_owner
    ? "OWNER APPROVAL REQUIRED before execution; do not delegate automatically."
    : "Execution allowed only under existing scoped, zero-spend, nonproduction owner policy.";
  return [
    MARKER(task.id),
    "",
    task.description,
    "",
    "Acceptance (independent proof required):",
    ...task.acceptance.map((s,i)=>`${i+1}. ${s}`),
    "",
    `Depends on native handoff IDs: ${(task.depends_on ?? []).join(", ") || "(none)"}`,
    approval,
    "Imported as backlog, unassigned; creating an issue is not completion proof."
  ].join("\n");
}

/** Import only after Paperclip owner activation and an authorized issue-creator credential.
 * Fail closed if listing or auth fails. Never auto-mark issues done or assign admins.
 * A single operator must run this at a time; Paperclip has no unique import-key constraint here.
 */
export async function importHandoff({manifest, apiOrigin, companyId, apiKey, approvedOrigin, fetcher=fetch, apply=false}={}) {
  const tasks = validateHandoff(manifest);
  const plan = tasks.map(t=>({id:t.id,title:t.title,priority:t.priority,requires_owner:t.requires_owner}));
  if (!apply) return {mode:"DRY_RUN_NO_NETWORK",tasks:plan,created:0};
  if (!UUID.test(String(companyId||"")) || typeof apiKey !== "string" || apiKey.trim().length < 20)
    throw Error("SCOPED_PAPERCLIP_CREDENTIAL_REQUIRED");
  const origin = normalizePrivateOrigin(apiOrigin);
  if (approvedOrigin !== origin) throw Error("PRIVATE_API_ORIGIN_NOT_APPROVED");
  if (typeof fetcher !== "function") throw Error("FETCHER_REQUIRED");

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept:"application/json",
    "Content-Type":"application/json",
  };
  const issueUrl = `${origin}/api/companies/${companyId}/issues`;
  async function request(url, method, body) {
    let resp;
    try { resp = await fetcher(url,{method,headers, ...(body ? {body:JSON.stringify(body)}:{}),redirect:"error",signal:AbortSignal.timeout(15000)}); }
    catch { throw Error("PAPERCLIP_API_UNREACHABLE"); }
    if (!resp?.ok) {
      if (resp?.status === 401 || resp?.status === 403) throw Error("PAPERCLIP_AUTHORIZATION_REQUIRED");
      if (resp?.status === 409) throw Error("PAPERCLIP_CONFLICT_RECONCILE_FIRST");
      if (resp?.status === 429) throw Error("PAPERCLIP_RATE_LIMITED_STOP");
      throw Error(`PAPERCLIP_HTTP_ERROR_${Number(resp?.status)||0}`);
    }
    try { return await resp.json(); } catch { throw Error("PAPERCLIP_INVALID_JSON"); }
  }
  let created=0, reused=0;
  for (const task of tasks) {
    // List again for each issue to recover safely after partial imports.
    // Never assume an empty/malformed response means there are zero existing issues.
    let matches=[];
    for(let offset=0, pages=0; pages<20; pages++,offset+=100) {
      const url=`${issueUrl}?limit=100&offset=${offset}`;
      const rows=await request(url,"GET");
      if(!Array.isArray(rows)) throw Error("PAPERCLIP_ISSUE_LIST_INVALID");
      matches.push(...rows.filter(issue=>typeof issue?.description==="string" && issue.description.split("\n").includes(MARKER(task.id))));
      if(rows.length<100) break;
      if(pages===19) throw Error("PAPERCLIP_ISSUE_LIST_TOO_LARGE");
    }
    if(matches.length>1) throw Error("PAPERCLIP_DUPLICATE_IMPORT_REQUIRES_REVIEW");
    if(matches.length===1) { reused++; continue; }
    const payload={title:task.title,description:renderDescription(task),status:"backlog",priority:task.priority <= 2 ? "high" : "medium"};
    const issued=await request(issueUrl,"POST",payload);
    if(!issued || !UUID.test(String(issued.id||"")) ||
      issued.title!==task.title || typeof issued.description !== "string" ||
      !issued.description.includes(MARKER(task.id))) throw Error("PAPERCLIP_CREATE_RECEIPT_INVALID");
    created++;
  }
  return {mode:"IMPORTED_AS_UNASSIGNED_BACKLOG",created,reused,total:tasks.length};
}

export async function main(env=process.env, argv=process.argv.slice(2)) {
  const apply=argv.length===1 && argv[0]==="--apply";
  if(argv.length>0 && !apply) throw Error("INVALID_FLAGS_USE_DRY_RUN_OR_APPLY");
  if(apply && env.PAPERCLIP_HANDOFF_OWNER_APPROVED!=="yes") throw Error("OWNER_IMPORT_APPROVAL_REQUIRED");
  let manifest;
  try {manifest=JSON.parse(env.PAPERCLIP_EXTERNAL_HANDOFF_V1 || "null");}
  catch {throw Error("HANDOFF_MANIFEST_INVALID_JSON");}
  return importHandoff({
    manifest,apply,apiOrigin:env.PAPERCLIP_EXTERNAL_API_ORIGIN,
    approvedOrigin:env.PAPERCLIP_EXTERNAL_APPROVED_ORIGIN,
    companyId:env.PAPERCLIP_COMPANY_ID,apiKey:env.PAPERCLIP_API_KEY,
  });
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().then(r=>console.log(JSON.stringify(r))).catch(err=>{
    console.error(String(err?.message||"HANDOFF_IMPORT_FAILED"));
    process.exitCode=1;
  });
}
