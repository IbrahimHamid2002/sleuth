# Sleuth

**The Autonomous Codebase Detective**

Sleuth is a local-first CLI that points at a GitHub repository (public or private) or a local folder, deterministically analyzes its structure, and generates three citation-backed Markdown documents — `README`, `ARCHITECTURE`, and `ONBOARDING`. Once analysis completes, you can interrogate the codebase directly through an autonomous, ReAct-based investigative agent ("Deep Dive") that answers open-ended questions with cited, verifiable answers.

[![npm version](https://img.shields.io/npm/v/sleuth-cli)](https://www.npmjs.com/package/sleuth-cli)
![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

---

## Installation

```bash
npm install -g sleuth-cli
```

Requires **Node.js 20 or newer**.

---

## Quick Start

```bash
# Analyze a public GitHub repo (writes 3 Markdown files to the current directory)
sleuth analyze https://github.com/some-org/some-repo

# Or analyze a local folder
sleuth analyze ./path/to/local/project

# Ask a question about the repo you just analyzed
sleuth ask "How does authentication work?"
```

`sleuth analyze` writes three files to the current working directory (or `--output`, if given):

- `README.generated.md`
- `ARCHITECTURE.md`
- `ONBOARDING.md`

The first time you run `sleuth analyze` or `sleuth ask`, you'll be prompted for free API keys if none are configured yet (see [AI / LLM Usage](#ai--llm-usage)).

---

## Commands

### `sleuth analyze <target>`

Analyzes a GitHub repository or local path and generates documentation.

| Flag              | Description                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--token <pat>`   | GitHub Personal Access Token, for analyzing private repositories                                                                                                                                |
| `--max-files <n>` | Maximum number of files to analyze (overrides the default priority-scoring cutoff)                                                                                                              |
| `--output <dir>`  | Output directory for the generated Markdown files (defaults to the current working directory)                                                                                                   |
| `--resume`        | Confirms/reports whether this run resumed from a previous interrupted run — caching is always on, so resuming happens automatically regardless of this flag; it only makes the behavior visible |

`<target>` is either a GitHub URL or a local folder path — Sleuth detects which based on the string.

### `sleuth ask [question]`

Asks a question about the most recently analyzed repository, reusing its sandbox without re-cloning.

- Pass a `question` argument to ask a single question and exit.
- Omit it to start an interactive REPL, asking one question at a time.
- In the REPL, type `exit`, `quit`, `bye`, or `goodbye` to end the session — this deletes the repository's temporary sandbox and clears session state.

Run `sleuth analyze` at least once before `sleuth ask`; there is no active session until an analysis has completed.

### `sleuth config`

Manages persisted API keys, stored locally at `~/.sleuth/config.json`. Keys stored here are read automatically on future runs and are **never transmitted anywhere except directly to the LLM provider whose key they are** — Sleuth does not have a backend server and never proxies your keys through one.

| Subcommand                        | Description                                             |
| --------------------------------- | ------------------------------------------------------- |
| `sleuth config set <key> <value>` | Save an API key for future runs                         |
| `sleuth config list`              | List which keys are configured (values are masked)      |
| `sleuth config clear`             | Delete `~/.sleuth/config.json`, clearing all saved keys |

Valid keys: `GROQ_SUMMARIZER_API_KEY`, `GROQ_SYNTHESIZER_API_KEY`, `GROQ_DEEP_DIVE_AGENT_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`. Any of these can also be set as real environment variables instead — an exported environment variable always takes precedence over a saved config value.

---

## How It Works

This is a simplified summary — see [ARCHITECTURE.md](https://github.com/IbrahimHamid2002/sleuth/blob/main/ARCHITECTURE.md) in the GitHub repository for the full technical specification.

**Documentation pipeline** (fully deterministic except for two LLM stages):

```
ingestion → framework detection → file discovery → priority scoring
→ import graph → LLM summarization → documentation synthesis
```

The repository is cloned into an isolated sandbox, then walked to detect frameworks, apply ignore rules, and build a lightweight import graph — all without any LLM calls. Files are scored and ranked by architectural significance, and only the highest-priority files are sent to an LLM for summarization. The three documents are then synthesized from those summaries, each via an independent LLM call so no single failure blocks the others.

**Deep Dive agent:** a ReAct-style loop — Plan → Reason → Act (via tools) → Observe → Reflect → Synthesize — that investigates your question against the actual repository content. It has six tools available: `search_docs`, `read_file`, `search_code`, `list_directory`, `get_file_summary`, and `find_references`, and prefers the pre-generated documents and file summaries over reading raw source whenever they're sufficient. Each investigation is bounded to at most 6 reasoning iterations, with a 60-second timeout per step.

---

## AI / LLM Usage

Sleuth uses three LLM providers, all on **free tiers** — you provide your own free API keys, Sleuth never bundles or shares one:

| Provider                                              | Get a free key                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Groq](https://console.groq.com/keys)                 | Primary provider for both the documentation pipeline and the Deep Dive agent   |
| [OpenRouter](https://openrouter.ai/keys)              | Secondary fallback for both the documentation pipeline and the Deep Dive agent |
| [Google Gemini](https://aistudio.google.com/api-keys) | Final fallback — **documentation pipeline only**                               |

The Deep Dive agent's provider chain is **Groq → OpenRouter only** — it deliberately does not fall back to Gemini. This is intentional: on a live, user-facing question-answering path, a stalled or blank-looking answer is worse than a clear, visible error, so if both Groq and OpenRouter fail, the agent surfaces an explicit error instead of silently degrading further.

**Configuring your keys:** run `sleuth analyze` or `sleuth ask` with no keys configured and you'll be prompted interactively — entered keys are saved to `~/.sleuth/config.json` for future runs. You can also manage them directly with `sleuth config set/list/clear`, or export any of the key names above as a real environment variable (which always takes precedence).

**Privacy & security guarantees:**

- A GitHub Personal Access Token (`--token`) is never logged, never written to disk, and never sent to any LLM provider — it exists only in memory for the duration of the clone operation.
- No repository content is permanently stored. The only persistent cache is a small SQLite file holding file-path/content-hash keys and short JSON summaries — never raw source code.
- All processing happens locally on your machine; nothing is uploaded to a Sleuth-operated server, because there isn't one.
- Every repository clone happens in a temporary sandbox directory that is deleted when analysis completes (if you don't continue into Deep Dive) or when your Deep Dive session ends.

---

## Limitations

Sleuth is intentionally scoped for speed and reliability over completeness. Documented limitations of the current version:

- **Regex-based analysis, not a full AST parser.** Import and symbol extraction use pattern matching rather than a real TypeScript/JavaScript parser. This is fast and dependency-light, and covers the vast majority of real-world code, but it can miss or misattribute unusual syntax that a full parser would catch.
- **Path aliases aren't resolved.** Imports like `@/utils/foo` aren't traced back to their real file in the import graph — only relative imports (`./`, `../`) are. This can under-count how central a file actually is.
- **Monorepo-aware, but single-pipeline.** Sleuth detects monorepo and multi-package structures and factors them into scoring and entry-point detection, but it still runs one analysis pass over the whole repository rather than a separate pipeline per package.
- **No persistent history.** Sleuth explains the current snapshot of a repository, not how it evolved — there's no git history analysis.
- **Single-process, local execution only.** There's no distributed processing, and Sleuth is best suited to repositories up to roughly 1000 analyzable files.

---

## Security

- **Ephemeral, isolated clones.** Every analysis clones into its own temporary sandbox directory, never a shared or persistent path, and that sandbox is deleted once you're done (pipeline completion, Deep Dive session exit, or idle timeout in the web app).
- **PAT handling.** A GitHub PAT passed via `--token` is used only in-memory for the clone step — never logged, never written to disk, never sent to an LLM.
- **Local-only processing.** All analysis and LLM calls happen directly from your machine to the LLM provider you configured — there is no Sleuth backend in the loop for the CLI.
- **No telemetry.** Sleuth does not collect or transmit any usage analytics or tracking data.

---

## Contributing

Issues and pull requests are welcome on the [GitHub repository](https://github.com/IbrahimHamid2002/sleuth). This project was built with Claude Code as an AI pair-programming assistant; see the repository's `prompts.md` for its development history.
