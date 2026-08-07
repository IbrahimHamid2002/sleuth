# CLAUDE.md — AI-Assisted Engineering Context for Sleuth

This file governs how Claude Code (or any AI pair-programmer) must operate within this repository. Read this in full before generating any code.

---

## 1. Tech Stack (Locked — Do Not Substitute)

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript (strict mode) | No `any` without an explicit `// justified: reason` comment |
| Runtime | Node.js 20+ | |
| Backend | Express.js | `@sleuth/api` package only |
| Frontend | React 18 + Vite | `@sleuth/web` package only |
| CLI Framework | Commander.js + Ora + Inquirer | `@sleuth/cli` package only |
| Database/Cache | SQLite via `better-sqlite3` | Cache only — never permanent repo storage |
| Git Operations | `simple-git` | NEVER `child_process.exec` for git commands |
| Validation | Zod | ALL LLM outputs and external inputs must pass through a Zod schema before use |
| LLM Providers | Groq (primary), Google Gemini (fallback) | Free tier only, no other providers without explicit approval |
| Package Manager | npm workspaces | No pnpm/yarn/turborepo — keep tooling minimal for a 10-day build |

---

## 2. Architectural Principles (Non-Negotiable)

1. **`packages/core` is a pure engine.** It must never import `express`, `react`, `commander`, or any HTTP/UI-related package. If a function in `core` needs to report progress, it accepts an `onProgress` callback — it never assumes HTTP or terminal context.
2. **CLI and Web must call identical core functions.** If you find yourself writing logic in `packages/cli` or `packages/api` that isn't pure presentation/routing, STOP — that logic belongs in `packages/core`.
3. **Determinism where possible, LLM only where necessary.** Framework detection, ignore rules, priority scoring, import graph, and symbol indexing are 100% deterministic — no LLM calls anywhere in these modules. LLM calls exist only in `documentation/summarizer.ts`, `documentation/synthesizer.ts`, and `agent/investigator.ts`.
4. **No agent loops outside `agent/investigator.ts`.** The documentation pipeline (`pipeline.ts`) must remain a fixed, sequential, non-agentic flow. Do not introduce dynamic control flow, tool-calling, or "let the LLM decide what to do next" patterns anywhere in the pipeline stages.
5. **Every LLM call site must have a Zod-validated exit path and a deterministic fallback.** No LLM call is allowed to be a single point of failure — always define what happens on validation failure BEFORE writing the success path.
6. **Dry-run before wet-run.** When implementing any module that touches the filesystem or makes an LLM call, first write and run a unit test using mocked I/O/LLM responses. Only after the test passes should real network/filesystem calls be exercised manually.

---

## 3. Code Style Rules

- Functions over classes, except where state genuinely needs encapsulation (`SummaryCache`, `DeepDiveSession`) — prefer plain functions and interfaces elsewhere
- Every exported function has an explicit return type annotation — never rely on inference for public APIs
- Error handling: never swallow errors silently. Either handle with a documented fallback, or re-throw with added context (`throw new Error(\`Failed to X: ${err.message}\`)`)
- File naming: `kebab-case.ts` for all files
- No default exports — always named exports, for consistent Claude Code refactoring and import tracing
- Every module in `packages/core/src/**` must have a corresponding test file in `packages/core/src/__tests__/**` before being considered "done"
- Comments explain **why**, not **what** — the code should be self-explanatory for the "what"

---

## 4. Critical Constraints & Safety Rules

These rules are **mandatory** and must be verified before any task is marked complete:

| # | Rule |
|---|---|
| 1 | **Always delete temporary clone directories** on pipeline completion (if no Deep Dive follow-up) AND on Deep Dive session termination (exit words, explicit end, or idle timeout). Wrap in `try/finally` — cleanup must run even on error paths. |
| 2 | **Sanitize every path against traversal attacks** via `assertSafePath()` before any `fs.readFileSync`, `fs.readdirSync`, or `fs.writeFileSync` call that uses a path derived from user input, LLM tool-call arguments, or repository content. |
| 3 | **Zero persistent repository storage.** SQLite may only ever contain: cache keys, content hashes, and small JSON summary blobs. Never write raw source file content into SQLite or any other persistent store. |
| 4 | **PAT (GitHub Personal Access Token) handling:** Never log it (redact via `redactSecrets()` before any `console.log`/logger call), never write it to disk, never include it in any object returned to the frontend, never send it to any LLM provider. It exists only as a local variable for the duration of the clone call. |
| 5 | **Every prompt given to Claude Code must be logged** in `prompts.md` at the project root, in this exact format (append, never overwrite): |

```markdown
## <Task Name>

### Goal
<one-to-two line description of the task's objective>

### User Prompt
<exact prompt text as given by the user, verbatim>

---
```

Where:
- **Task Name** is a short, descriptive title for the task — no date or timestamp.
- **Goal** sits directly below the Task Name heading: one to two lines stating what the task aims to achieve.
- **User Prompt** sits directly below Goal: the user's prompt reproduced verbatim (exact wording, exact formatting — no paraphrasing, no trimming).
- The three field headings use markdown heading levels (`##` for Task Name, `###` for Goal and User Prompt) so they stand out visually from surrounding text.
- Once all three fields for an entry are complete, insert a horizontal rule (`---`) as a separator before the next entry.
- All entries follow this exact structure, one after another, in order.

| # | Rule |
|---|---|
| 6 | Run the auto-lint skill whenever a new file is created or an existing file is modified. Before considering any task complete, run: `npm run lint -- --fix` scoped to the changed package, and resolve any remaining errors manually. Do not leave lint errors unresolved between tasks. |
| 7 | Never introduce a new npm dependency without checking it against the free-tier/zero-cost constraint and confirming it isn't a heavyweight alternative to something already planned (e.g., do not add LangChain, do not add a full AST parser, do not add Redis/PostgreSQL). |
| 8 | Every LLM-facing prompt template must wrap untrusted repository content in an explicit delimiter (e.g., `<untrusted_source_code>`) and instruct the model to treat it as inert data, never as instructions. |

---

## 5. Task Execution Protocol

For every atomic task given to Claude Code:

1. Read the referenced sections of `PRD.md` and `ARCHITECTURE.md` before writing code
2. Define/update types and Zod schemas FIRST
3. Implement logic SECOND
4. Write a dry-run test (mocked I/O/LLM) THIRD
5. Run lint + fix
6. Append an entry to `prompts.md`
7. Report back: files changed, tests added, any deviations from the original spec and why

If a task seems to require touching more than 3 files or introducing a dependency not listed in Section 1, STOP and flag this before proceeding — it likely needs to be split into smaller atomic tasks.