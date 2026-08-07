import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface DocsNavSection {
  anchorId: string;
  label: string;
}

const DOCS_NAV_SECTIONS: DocsNavSection[] = [
  { anchorId: 'overview', label: 'Overview' },
  { anchorId: 'installation', label: 'Installation' },
  { anchorId: 'workflow', label: 'Workflow' },
  { anchorId: 'analyze-command', label: 'sleuth analyze' },
  { anchorId: 'ask-command', label: 'sleuth ask' },
  { anchorId: 'config-command', label: 'sleuth config' },
  { anchorId: 'repository-sources', label: 'Repository sources' },
  { anchorId: 'pat-security', label: 'PAT security' },
  { anchorId: 'generated-documents', label: 'Generated documents' },
  { anchorId: 'deep-dive-sessions', label: 'Deep Dive sessions' },
];

function CodeBlock({ children }: { children: string }): React.JSX.Element {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs sm:text-sm">
      <code>{children}</code>
    </pre>
  );
}

export function DocsPage(): React.JSX.Element {
  return (
    <div className="container grid grid-cols-1 gap-8 py-12 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Documentation sections" className="lg:sticky lg:top-20 lg:self-start">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          On this page
        </h2>
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm lg:flex-col lg:gap-2">
          {DOCS_NAV_SECTIONS.map((section) => (
            <li key={section.anchorId}>
              <a
                href={`#${section.anchorId}`}
                className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex max-w-3xl flex-col gap-8">
        <header>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Sleuth CLI Documentation</h1>
          <p className="mt-2 text-muted-foreground">
            The command-line interface is Sleuth&apos;s first-class way to analyze a repository —
            it runs fully locally with zero deployment dependency.
          </p>
        </header>

        <Card id="overview" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>What the Sleuth CLI does</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">sleuth</code> clones
              (or reads) a repository, deterministically detects its frameworks and highest-priority
              files, summarizes them with an LLM, and synthesizes three Markdown documents:
              a README, an ARCHITECTURE overview, and an ONBOARDING guide. Once analysis finishes,
              you can keep asking the repository questions through a Deep Dive investigation agent
              without re-cloning.
            </p>
          </CardContent>
        </Card>

        <Card id="installation" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Installation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              Sleuth is currently distributed as source in this npm-workspaces monorepo, not as a
              published npm package. To install it locally:
            </p>
            <CodeBlock>{`git clone <this-repo-url>
cd sleuth
npm install
npm run build --workspaces`}</CodeBlock>
            <p>
              Then link the CLI package so the <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">sleuth</code> command
              is available on your PATH:
            </p>
            <CodeBlock>{`cd packages/cli
npm link`}</CodeBlock>
            <p>
              Alternatively, run it directly without linking:
            </p>
            <CodeBlock>{'node packages/cli/dist/index.js analyze <target>'}</CodeBlock>
          </CardContent>
        </Card>

        <Card id="workflow" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>CLI workflow</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Run <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">sleuth analyze &lt;target&gt;</code> to
                clone/ingest a repository and generate the three documents in your working directory.
              </li>
              <li>
                Open the generated <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">README.generated.md</code>,{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">ARCHITECTURE.md</code>, and{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">ONBOARDING.md</code> to inspect the results.
              </li>
              <li>
                Run <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">sleuth ask</code> to start asking
                follow-up questions about the repository — it resumes the same session, so nothing is re-cloned.
              </li>
            </ol>
          </CardContent>
        </Card>

        <Card id="analyze-command" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>sleuth analyze</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <CodeBlock>{'sleuth analyze <target> [--token <pat>] [--max-files <n>] [--output <dir>] [--resume]'}</CodeBlock>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">&lt;target&gt;</code> — a{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">https://github.com/owner/repo</code> URL
                or a local filesystem path.
              </li>
              <li>
                <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">--token &lt;pat&gt;</code> — a GitHub
                Personal Access Token, required only for private repositories.
              </li>
              <li>
                <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">--max-files &lt;n&gt;</code> — caps how
                many files are analyzed.
              </li>
              <li>
                <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">--output &lt;dir&gt;</code> — directory to
                write the generated Markdown into (defaults to the current working directory).
              </li>
              <li>
                <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">--resume</code> — confirms/reports
                whether the run reused cached file summaries from a previous interrupted run. Caching
                is always on regardless of this flag; it only makes the behavior visible.
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card id="ask-command" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>sleuth ask</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <CodeBlock>{'sleuth ask [question]'}</CodeBlock>
            <p>
              Run with a question as a single-shot query, or with no arguments to start an
              interactive REPL. Either way it resumes the most recently analyzed repository — no
              re-cloning needed. Type one of the following exit words to end an interactive session
              (this also cleans up the ephemeral sandbox):
            </p>
            <div className="flex flex-wrap gap-2">
              {['exit', 'quit', 'bye', 'goodbye'].map((exitWord) => (
                <code key={exitWord} className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                  {exitWord}
                </code>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card id="config-command" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>sleuth config</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <CodeBlock>{`sleuth config set <key> <value>
sleuth config list`}</CodeBlock>
            <p>
              Manages API keys persisted to <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">~/.sleuth/config.json</code>,
              used automatically by future runs when the matching environment variable isn&apos;t
              already exported. Valid keys:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li><code className="rounded bg-muted px-1.5 py-0.5 text-foreground">GROQ_SUMMARIZER_API_KEY</code></li>
              <li><code className="rounded bg-muted px-1.5 py-0.5 text-foreground">GROQ_SYNTHESIZER_API_KEY</code></li>
              <li><code className="rounded bg-muted px-1.5 py-0.5 text-foreground">GROQ_DEEP_DIVE_AGENT_API_KEY</code></li>
              <li><code className="rounded bg-muted px-1.5 py-0.5 text-foreground">OPENROUTER_API_KEY</code></li>
              <li><code className="rounded bg-muted px-1.5 py-0.5 text-foreground">GEMINI_API_KEY</code></li>
            </ul>
            <p>
              <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">sleuth config list</code> prints which
              keys are configured, with values masked. If a run needs a key that isn&apos;t set
              anywhere (and no fallback provider key is usable), Sleuth prompts for it interactively
              and offers to save it for next time.
            </p>
          </CardContent>
        </Card>

        <Card id="repository-sources" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Public GitHub, private GitHub, and local paths</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-foreground">Public GitHub repository</strong> — pass the{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">https://github.com/owner/repo</code> URL
                as the target; no token needed.
              </li>
              <li>
                <strong className="text-foreground">Private GitHub repository</strong> — pass the
                same URL along with <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">--token &lt;pat&gt;</code> (CLI)
                or the PAT field (Web).
              </li>
              <li>
                <strong className="text-foreground">Local path</strong> — pass a filesystem path
                instead of a URL (CLI only; the Web UI only accepts a repository URL).
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card id="pat-security" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>PAT security note</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              A Personal Access Token is only ever held in memory for the duration of the clone
              request. It is never written to disk, never logged, never sent to any LLM provider,
              and never persisted anywhere — on the Web UI it lives only in ephemeral component
              state and is cleared immediately after the request completes, whether it succeeds or
              fails.
            </p>
          </CardContent>
        </Card>

        <Card id="generated-documents" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>The three generated documents</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-foreground">README</strong> — a high-level introduction to
                the project: what it does, how it&apos;s structured, and how to get started.
              </li>
              <li>
                <strong className="text-foreground">ARCHITECTURE</strong> — a deeper technical
                overview of modules, data flow, and (where applicable) Mermaid diagrams.
              </li>
              <li>
                <strong className="text-foreground">ONBOARDING</strong> — a guide oriented toward a
                new contributor getting productive in the codebase.
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card id="deep-dive-sessions" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Deep Dive sessions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              After <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">sleuth analyze</code> completes,{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">sleuth ask</code> starts (or resumes) a
              Deep Dive session backed by the same ephemeral sandbox — the agent investigates the
              actual source to answer questions it can&apos;t answer from the generated documents or
              file summaries alone. A session ends, and its sandbox is cleaned up, when you send one
              of the exit words above, close the CLI, or (on the Web UI) after an idle timeout.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
