# Sleuth — Product Requirements Document

**The Autonomous Codebase Detective**

Version: 1.0 (MVP) | Timeline: 10 Days | Status: Locked Scope

---

## 1. Executive Summary & Core Objective

Sleuth is a local-first developer tool that ingests a GitHub repository (public or private via PAT) or a local folder, deterministically analyzes its structure, generates three citation-backed Markdown documents (README, ARCHITECTURE, ONBOARDING), and then allows the user to interrogate the codebase through an autonomous ReAct-based investigative agent ("Deep Dive").

**Core Objective (MVP):** Reduce the time it takes a developer to understand an unfamiliar repository from hours/days to minutes, using a deterministic analysis pipeline (for reliability) combined with exactly one well-scoped agentic feature (for depth).

**This is explicitly NOT an attempt to compete with Greptile, Sourcegraph, or Mintlify.** Sleuth is free, local-first, and scoped for individuals — not enterprise semantic-search platforms.

---



## 2. Target Persona


| Persona                    | Need                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| **Individual Developer**   | Joining a new open-source project or personal project after a long break; needs fast orientation |
| **CS Student**             | Studying real-world codebases for learning; needs structural explanations, not just code dumps   |
| **Small Engineering Team** | Onboarding a new hire without dedicating senior engineer time to a walkthrough                   |


**Primary Use Case:** Point Sleuth at a repo → get 3 documents in ~2 minutes → ask follow-up questions ("How does auth work?", "Trace the request lifecycle") and get cited, verifiable answers.

---



## 3. Anti-Goals (Explicitly Excluded from MVP)

Sleuth explains the **current snapshot** of a repository only. The following are **out of scope** and must not be implemented, even partially:


| Excluded Feature                                    | Reason                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Vector Databases / Embeddings / Semantic Search** | Adds infrastructure dependency incompatible with local-first, deterministic positioning |
| **Git History Analysis**                            | MVP explains "what is," not "how it evolved"                                            |
| **Real-Time Synchronization / File Watchers**       | This is a one-shot analysis tool, not an IDE plugin                                     |
| **Live Monitoring / CI Integration**                | No automated triggers; manual, on-demand only                                           |
| **Multi-User Collaboration / Team Workspaces**      | No auth system, no shared state — single-user sessions only                             |
| **Distributed Processing**                          | Single-process pipeline is sufficient at MVP scale (≤1000 files)                        |
| **OAuth App for GitHub**                            | PAT-based auth only — simpler, faster, sufficient for MVP                               |
| **Full AST Parsing**                                | Regex-based static analysis only — see ARCHITECTURE.md rationale                        |


Any request to add these mid-build must be deferred to a "Future Improvements" backlog, not implemented.

---



## 4. Core Functional Requirements



### 4.1 Repository Processing

- Accept input as: public GitHub URL, private GitHub URL + PAT, or local folder path
- Support repositories up to ~1000 analyzable files (hard discovery cap: 1500 files)
- Shallow clone only (`--depth 1`) — no full history fetch
- All processing happens in an isolated, ephemeral sandbox directory



### 4.2 Framework Detection (Deterministic — Zero LLM Calls)

- Detect: React, Next.js, Express, NestJS, Vite
- Detect monorepo structure via `pnpm-workspace.yaml`, `lerna.json`, `turbo.json`, `nx.json`, or `package.json.workspaces`
- Detect package manager (npm/yarn/pnpm) via lockfile presence
- Must be 100% deterministic — pure file/JSON inspection, no model inference



### 4.3 Ignore Rules

- Respect `.gitignore`
- Hardcoded exclusions: `node_modules`, `dist`, `build`, `coverage`, `.cache`, generated code, binaries, images/video, logs, lockfiles, test files/folders, snapshots
- Never follow symlinks
- Skip binary files via null-byte detection on first 512 bytes



### 4.4 Priority Scoring Engine

- Deterministic formula: `PathScore + ImportScore + EntryPointBonus`
- PathScore: tiered lookup table based on architectural significance of file path
- ImportScore: derived from a lightweight regex-based import graph (in-degree count)
- EntryPointBonus: signature-based detection (`app.listen(`, `ReactDOM.createRoot(`, etc.) — not filename-based
- Top ~150 files (configurable) selected for LLM summarization after sorting



### 4.5 Caching

- SQLite (via `better-sqlite3`) used strictly as a **cache**, never as permanent storage
- Cache key: `sha256(repoId + commitHash + filePath + contentHash + promptVersion)`
- 7-day TTL; cache invalidated automatically on content or prompt-version change
- Deep Dive sessions maintain a **separate in-memory** visited-file cache (session-scoped, never touches SQLite)



### 4.6 Documentation Generation

- Generate exactly 3 documents: `README.md`, `ARCHITECTURE.md`, `ONBOARDING.md`
- Each document generated via an **independent** LLM call (no single point of failure)
- Every architectural claim must include a `[file:line]` citation, generated via **deterministic symbol-index cross-referencing**, not LLM-invented line numbers
- ARCHITECTURE.md must contain a Mermaid diagram, explicitly labeled as an **approximation**, not a guaranteed reverse-engineered UML diagram
- Template-based fallback generation if any LLM call fails validation



### 4.7 Deep Dive ReAct Agent

- Activated after documentation generation completes
- Answers open-ended questions ("Explain authentication", "Trace the request lifecycle")
- Implements: Planning → Reasoning → Tool Use → Observation → Reflection → Synthesis
- 5 tools: `read_file`, `search_code`, `list_directory`, `get_file_summary`, `find_references`
- Must prefer `get_file_summary()` over `read_file()` whenever possible
- Hard bounds: max 10 iterations, 60-second total timeout
- Session terminates on: user typing `exit`/`quit`/`bye`/`goodbye` (CLI), explicit "End Session" (Web), or 30-minute idle timeout (Web only)
- Termination MUST delete the sandboxed repo clone and clear all in-memory session state
- Provider routing (interactive/user-facing, distinct from the doc-synthesis pipeline's provider chain): Groq first, OpenRouter as the sole and FINAL fallback (model: `nvidia/nemotron-3-ultra-550b-a55b:free`) — no third provider. If both fail, the agent surfaces a clear, explicit error to the user in real time; it must never silently degrade to a placeholder response, since a stalled or blank-looking answer on a live, user-facing path is worse than a visible error



### 4.8 CLI (First-Class Interface)

- `sleuth analyze <target> [--token PAT] [--max-files N] [--output DIR]`
- `sleuth ask [question]` — resumes last session or starts an interactive REPL
- Must work with **zero deployment dependency** — fully local execution
- Generated Markdown written to current working directory by default



### 4.9 Web UI (Secondary Interface — Same Engine)

- Repository URL input + optional PAT field (collapsible, clearly labeled as never stored)
- Live progress stepper mirroring pipeline stages
- Tabbed document viewer (README / ARCHITECTURE / ONBOARDING / Deep Dive) with Markdown + Mermaid rendering
- Download buttons: individual docs + "Download All" (ZIP)
- Deep Dive chat interface with **live streaming reasoning trace** via Server-Sent Events (SSE)

---



## 5. Security & Data Handling Specifications


| Requirement                     | Specification                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ephemeral Clones**            | Every clone goes into `os.tmpdir()/sleuth/{uuid}/` — never a shared or persistent path                                                                                                              |
| **Cleanup Guarantee**           | Sandbox deleted on: pipeline completion (if no Deep Dive follow-up), Deep Dive session exit, or idle-timeout reaper (Web, 30 min)                                                                   |
| **PAT Handling**                | Never written to disk, never logged (redaction middleware strips `ghp_`*/`github_pat_*` patterns from all logs), never sent to any LLM, exists only in-memory for the duration of the clone request |
| **Path Traversal Protection**   | Every filesystem operation validated via `assertSafePath()` using `fs.realpathSync` to defeat symlink-based bypass                                                                                  |
| **Prompt Injection Mitigation** | File content sanitized before LLM ingestion; all LLM outputs validated against strict Zod schemas; agent has zero code-execution capability                                                         |
| **No Persistent Repo Storage**  | At no point is a full repository permanently stored — SQLite holds only small JSON summaries, never raw source code                                                                                 |
| **Rate Limiting**               | Max 2 concurrent pipeline runs, max 1 concurrent Deep Dive session per IP (Web only)                                                                                                                |


---



## 6. Success Metrics (MVP)


| Metric                                                                 | Target                              |
| ---------------------------------------------------------------------- | ----------------------------------- |
| Time to generate 3 documents (150-file repo)                           | < 90 seconds                        |
| Cache hit rate on re-run of unchanged repo                             | > 90%                               |
| Deep Dive investigation average iterations                             | 4–8 (well within the 10 cap)        |
| Framework detection accuracy (React/Next/Express/NestJS/Vite fixtures) | 100% (deterministic, testable)      |
| Sandbox cleanup success rate                                           | 100% (verified via automated tests) |
| PAT leakage in logs                                                    | 0 occurrences (automated grep test) |


---



## 7. MVP Constraints

- **Hard deadline: 10 days**, single developer, using Claude Code as the primary implementation assistant
- Every new engineering decision must be checked against Section 3 (Anti-Goals) before implementation
- If a proposed feature cannot be completed in a single day's milestone slot without risking downstream days, it is deferred to "Future Improvements," not compressed or corner-cut
- All LLM usage must remain on 100% free-tier providers (Groq primary, OpenRouter secondary fallback, Gemini final fallback)

