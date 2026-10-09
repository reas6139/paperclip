---
name: ecosystem-graphify-obsidian-memory
description: "Retrieve source-attributed, read-only AI Ecosystem code knowledge from Graphify and Obsidian vault snapshots when a configured and authorized bridge is available. Never treat a graph snapshot as live system state."
---

# AI Ecosystem — Graphify / Obsidian Memory

**Status:** Optional capability specification. It is not auto-installed, does not configure agent access, and must not be described as active until a Paperclip heartbeat successfully invokes the bridge and produces a cited result.

## Purpose and boundaries

- Paperclip is the control plane: task assignment, company isolation, approvals, budgets, and audit trails.
- Graphify is a derived architecture graph, **not** a source of operational truth.
- Obsidian is a Markdown view of verified project knowledge, **not** a writable multi-agent task bus.
- Existing `para-memory-files` remains the agent's own durable memory framework. Do not replace or conflate it with a shared vault.
- Original repositories, issue records, deployments, and approved documents remain authoritative.

## Access / least privilege

A host operator may configure `ECOSYSTEM_MEMORY_BRIDGE` to point to the local on-demand Node.js reader `paperclip-memory-readonly.cjs` on the machine where the Obsidian vault actually exists. The reader supports `status`, `search <term>`, `read <basename.md>`, and `query <question>`.

Invoke with argument vectors (not by interpolating arbitrary user/task text into shell command strings). No elevated privileges, token forwarding, network sharing, hidden synchronization, or host-computer remote mounting. No auto-watchers or background indexing. Restrict CPU/time/memory to the operator's approved limits.

If `ECOSYSTEM_MEMORY_BRIDGE` is unavailable, **do not pretend Obsidian is connected**. If a trusted local `graphify-out/graph.json` and the compatible `graphify` CLI are present in the agent's checkout, a graph-only query can be used with the correct checkout commit and verified provenance; otherwise mark retrieval unavailable.

## Workflow (per approved Paperclip task)

1. Verify bridge availability and run its `status` command. If it reports dirty working tree, missing source, or an unmatched commit, mark the graph **snapshot/stale**; do not assert current design from it.
2. Search/ask only for relevant code entities or concepts; keep output budgets narrow.
3. Retrieve a note with `read` and capture its `source_file`, `location`, and extraction provenance.
4. Cross-check actionable conclusions against the original source code or current authoritative issue/deployment records.
5. Report results with source path, commit or freshness status, and uncertainty. Use Paperclip's normal audited task/comment interfaces for work updates.
6. For absent bridge, permission denials, stale-index misfit, or failed query: fail closed and report **BLOCKED/UNVERIFIED** rather than inventing memory or requesting owner permissions outside approvals.

## Test gate before rollout

- [ ] Agent runtime path and company identity verified.
- [ ] Env/skill injection verified without leaking local paths or secrets into public logs.
- [ ] Real Paperclip heartbeat executes `status`, `search`, and `query`.
- [ ] Heartbeat reads source-linked answer and independently corroborates a current source file.
- [ ] Unauthorized file traversal and missing-vault conditions fail closed.
- [ ] Token/cost, CPU/memory, and rollback checks pass.
- [ ] Explicit approval for any production config changes or ongoing sync.

Until all relevant gates pass, classify this as **IMPLEMENTED IN FEATURE BRANCH ONLY**, not operational or persistent shared agent memory.
