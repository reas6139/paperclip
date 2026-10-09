# External control-plane handoff — owner-gated

This is a **Paperclip-side staging mechanism**, not an autonomous scheduler. It lives in Paperclip's own repository and reads a bounded manifest stored **only as a Railway variable on the Paperclip service**. No ecosystem task queue, service-role key or Jarvis admin is required by the importer.

## State and prerequisites

- Paperclip runtime is `authenticated/private`, on Railway's private network, with its own Postgres. No public domain for a `bootstrap_pending` instance.
- A human must complete Paperclip's documented **first instance-admin claim**. This importer **cannot claim admin**, mint agent keys, or impersonate the owner. See `doc/DEPLOYMENT-MODES.md` section 8.
- Once activated, an operator provisions a **separately scoped, authenticated issue-creator identity** with company membership, not an instance-admin or Supabase `service_role` key.
- `PAPERCLIP_EXTERNAL_HANDOFF_V1` is a JSON string. It is stored on the external Paperclip Railway service (currently only **staged for future process use**, with `skipDeploys`, not yet imported). No secrets are included in this value.
- The manifest contains **six ordered acceptance milestones**, not every legacy queue row. Unsafe, duplicate, failed, paused, or unverified historical tasks must not be swept blindly into Paperclip.

## Safe import, after authenticated owner setup

Use a trusted Railway-internal process, **not a user's computer or a public website**. Export these variables only in the private process:

```sh
PAPERCLIP_EXTERNAL_API_ORIGIN=http://paperclip-cloud-controller.railway.internal:3100
PAPERCLIP_EXTERNAL_APPROVED_ORIGIN=http://paperclip-cloud-controller.railway.internal:3100
PAPERCLIP_COMPANY_ID=<real-approved-company-uuid>
PAPERCLIP_API_KEY=<real-issue-creator-key>
PAPERCLIP_HANDOFF_OWNER_APPROVED=yes
```

Start with `node scripts/external-handoff/import.mjs`: **dry run only**, no network, no credential needed. When the human instance owner has authorized the intake and real company and scoped key are present, run `node scripts/external-handoff/import.mjs --apply`.

`--apply` first retrieves existing issues, checks each exact `paperclip-handoff-key:` receipt to avoid duplicates after interrupted imports, then creates **unassigned `backlog`** issues via Paperclip's official company issue API. It does not mark work done, assign agents, create company admins, release quarantines, or start a second scheduler. Cross-issue dependencies initially remain explicit text and must be attached to native issue relations before scheduling.

The importer intentionally refuses an unapproved hostname, anything outside Railway private HTTP, a missing credential, unauthorized access, HTTP 409/429, malformed server responses, ambiguous duplicate markers, and more than 2,000 issue rows. Importing is **not verified execution**. No action against production or actual fork agents may occur before native checkout, authenticated run ownership, real result/test receipts, independent review, then a second distinct task without an active ChatGPT chat.

## Lifecycle and cutover

1. **PREPARED** — manifest persisted externally, importer code isolated, Jarvis manager disabled, original task history retained.
2. **IMPORT_READY** — human has verified private Paperclip owner and approved issue-creator identity.
3. **ISSUES_IMPORTED** — API returned real native issues, deduplicated and unassigned; record issue IDs and import receipts.
4. **EXECUTOR_PROVEN** — Paperclip agent safely checked out an issue, delegated via one lease to a verified fork, and received independent result/test/review evidence.
5. **CONTINUATION_PROVEN** — Paperclip autonomously completed a second **distinct** useful issue and recovered from a controlled restart.
6. **CUTOVER** — only then stop the old ecosystem assignment/dispatcher loop; preserve historical records, memory, rollbacks, expense gates, and independent safety checks. Do not disable safety crons or turn Jarvis back on.

Do not treat `NODE_SERVER_HEALTHY`, a git commit, a manifest, a GitHub issue, an AI-written `PASS`, or a periodic monitor as actual Paperclip issue completion. The user retains final approval for expenses, privilege changes, production merges and destructive operations.

### Tests

`node --test scripts/external-handoff/import.test.mjs`

The tests use mock HTTP and confirm fail-closed import logic only. They **do not** substitute for testing against an authenticated native Paperclip instance.

### Legacy queue quarantine

At the latest read-only inventory the ecosystem had **164 waiting/queued sandbox tasks**, including **105 assigned to the retired Jarvis owner** (81 waiting, 24 queued). These are **not** authorized to be bulk-imported: many contain obsolete Jarvis management, previous failures, or unresolved approvals. Preserve source records, quarantine duplicates and stale tasks, and import only fresh, validated, owner-approved implementation briefs into Paperclip. The six-step manifest is takeover infrastructure, **not a claim that those 164 existing tasks have migrated**.

The isolated importer smoke workflow uses **Node 24**, per Paperclip's repository policy. The broader CI can fail independently on upstream Docker Hub authentication or image retrieval outages, which are not successful deployment receipts.
