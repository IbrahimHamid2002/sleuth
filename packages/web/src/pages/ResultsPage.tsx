import { useEffect, useId, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import type { AuditEntry, RepoMeta } from '@/api';
import { downloadResults } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useAnalysis } from '@/hooks/useAnalysis';
import { cn } from '@/lib/utils';

import 'highlight.js/styles/github-dark.css';

type SelectedDocumentationTab = 'readme' | 'architecture' | 'onboarding' | 'deep-dive';

function EmptyState({
  title,
  description,
  linkTo,
  linkLabel,
}: {
  title: string;
  description: string;
  linkTo: string;
  linkLabel: string;
}): React.JSX.Element {
  return (
    <div className="container flex justify-center py-16">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm text-muted-foreground">
          <p role="alert">{description}</p>
          <Button asChild size="sm" className="w-fit">
            <Link to={linkTo}>{linkLabel}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ResultsLoadingSkeleton(): React.JSX.Element {
  return (
    <div className="container flex flex-col gap-4 py-10">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-6 w-96" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function MermaidDiagram({ chart }: { chart: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasRenderError, setHasRenderError] = useState(false);
  const diagramId = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useEffect(() => {
    let isUnmounted = false;

    async function renderMermaidDiagram(): Promise<void> {
      try {
        // Dynamically imported so mermaid never enters the top-level bundle —
        // only paid for when an ARCHITECTURE doc actually contains a diagram.
        const { default: mermaid } = await import('mermaid');

        // Generated repository documentation is untrusted content — 'strict'
        // disables HTML labels/tags in diagram text instead of the default,
        // more permissive security level.
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

        const { svg } = await mermaid.render(diagramId, chart);

        if (!isUnmounted && containerRef.current !== null) {
          containerRef.current.innerHTML = svg;
        }
      } catch {
        if (!isUnmounted) {
          setHasRenderError(true);
        }
      }
    }

    void renderMermaidDiagram();

    return () => {
      isUnmounted = true;
    };
  }, [chart, diagramId]);

  if (hasRenderError) {
    return (
      <pre className="my-4 overflow-x-auto rounded-md border p-4 text-xs">
        <code>{chart}</code>
      </pre>
    );
  }

  return <div ref={containerRef} className="my-4 flex justify-center overflow-x-auto" />;
}

function DocumentMarkdown({
  markdown,
  enableMermaidDiagrams = false,
}: {
  markdown: string;
  enableMermaidDiagrams?: boolean;
}): React.JSX.Element {
  const markdownComponents: Components = {
    h1: ({ children }) => <h1 className="mt-8 text-2xl font-bold tracking-tight first:mt-0 sm:text-3xl">{children}</h1>,
    h2: ({ children }) => <h2 className="mt-6 text-xl font-semibold tracking-tight sm:text-2xl">{children}</h2>,
    h3: ({ children }) => <h3 className="mt-5 text-lg font-semibold sm:text-xl">{children}</h3>,
    h4: ({ children }) => <h4 className="mt-4 text-base font-semibold">{children}</h4>,
    p: ({ children }) => <p className="my-3 text-sm leading-relaxed sm:text-base">{children}</p>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-primary">
        {children}
      </a>
    ),
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 text-sm sm:text-base">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 text-sm sm:text-base">{children}</ol>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-border pl-4 text-sm italic text-muted-foreground">{children}</blockquote>
    ),
    hr: () => <hr className="my-6 border-border" />,
    strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
    th: ({ children }) => <th className="px-3 py-2 text-left font-semibold">{children}</th>,
    td: ({ children }) => <td className="border-t border-border px-3 py-2">{children}</td>,
    pre: ({ children }) => <pre className="my-4 overflow-x-auto rounded-md border p-4">{children}</pre>,
    code: (codeProps) => {
      const { className, children } = codeProps;
      const languageMatch = /language-(\w+)/.exec(className ?? '');
      const language = languageMatch?.[1];

      if (enableMermaidDiagrams && language === 'mermaid') {
        return <MermaidDiagram chart={String(children).replace(/\n$/, '')} />;
      }

      if (className !== undefined) {
        return <code className={cn('font-mono text-xs sm:text-sm', className)}>{children}</code>;
      }

      return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">{children}</code>;
    },
  };

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
      {markdown}
    </ReactMarkdown>
  );
}

function DocumentDownloadButton({
  label,
  fileName,
  markdown,
}: {
  label: string;
  fileName: string;
  markdown: string;
}): React.JSX.Element {
  const { toast } = useToast();

  function handleDownload(): void {
    try {
      const markdownBlob = new Blob([markdown], { type: 'text/markdown' });
      const objectUrl = URL.createObjectURL(markdownBlob);
      const downloadAnchor = document.createElement('a');

      downloadAnchor.href = objectUrl;
      downloadAnchor.download = fileName;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      document.body.removeChild(downloadAnchor);
      URL.revokeObjectURL(objectUrl);

      toast({ title: 'Download started', description: fileName });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Download failed',
        description: err instanceof Error ? err.message : `Could not download ${fileName}.`,
      });
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleDownload}>
      Download {label}
    </Button>
  );
}

function RepositoryMetadataCard({ meta, filesSummarizedCount, durationMs }: { meta: RepoMeta; filesSummarizedCount: number; durationMs: number }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Repository</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{meta.name}</dd>
          <dt className="text-muted-foreground">Identifier</dt>
          <dd className="break-all">{meta.identifier}</dd>
          <dt className="text-muted-foreground">Commit</dt>
          <dd className="break-all font-mono text-xs">{meta.commitHash}</dd>
          <dt className="text-muted-foreground">Package manager</dt>
          <dd>{meta.packageManager}</dd>
          <dt className="text-muted-foreground">Monorepo</dt>
          <dd>{meta.isMonorepo ? `Yes (${meta.monorepoType})` : 'No'}</dd>
          {/* summaries is capped at the top 50 by @sleuth/api (see packages/api/src/routes/analyze.ts)
             — labeled precisely as "summarized" rather than implying it's the repo's total file count. */}
          <dt className="text-muted-foreground">Files summarized</dt>
          <dd>{filesSummarizedCount}</dd>
          <dt className="text-muted-foreground">Duration</dt>
          <dd>{(durationMs / 1000).toFixed(1)}s</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

function DetectedFrameworksCard({ frameworks }: { frameworks: string[] }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Detected frameworks</CardTitle>
      </CardHeader>
      <CardContent>
        {frameworks.length === 0 ? (
          <p className="text-sm text-muted-foreground">None detected.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {frameworks.map((framework) => (
              <li key={framework} className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                {framework}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AuditLogCard({ repositoryAuditEntries }: { repositoryAuditEntries: AuditEntry[] }): React.JSX.Element {
  const [isAuditLogExpanded, setIsAuditLogExpanded] = useState(false);
  const auditLogContentId = useId();

  return (
    <Card>
      <Collapsible open={isAuditLogExpanded} onOpenChange={setIsAuditLogExpanded}>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>Audit log</CardTitle>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={isAuditLogExpanded}
              aria-controls={auditLogContentId}
            >
              {repositoryAuditEntries.length} entries
            </Button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent id={auditLogContentId}>
          <CardContent className="flex max-h-64 flex-col gap-2 overflow-y-auto text-xs">
            {repositoryAuditEntries.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className="border-b border-border pb-1.5 last:border-0">
                <p className="font-medium">
                  {entry.stage} · {entry.action}
                </p>
                <p className="text-muted-foreground">{entry.detail}</p>
              </div>
            ))}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export function ResultsPage(): React.JSX.Element {
  const { runId } = useParams<{ runId: string }>();
  const { toast } = useToast();
  const { status, results, error, isLoading } = useAnalysis(runId);
  const [selectedDocumentationTab, setSelectedDocumentationTab] = useState<SelectedDocumentationTab>('readme');

  useEffect(() => {
    if (error !== undefined) {
      toast({ variant: 'destructive', title: 'Could not load results', description: error });
    }
  }, [error, toast]);

  if (runId === undefined || runId.length === 0) {
    return (
      <EmptyState
        title="No analysis run specified"
        description="This page needs a run ID in the URL."
        linkTo="/web"
        linkLabel="Start a new analysis"
      />
    );
  }

  if (error !== undefined) {
    return <EmptyState title="Could not load this analysis" description={error} linkTo="/web" linkLabel="Start a new analysis" />;
  }

  if (status !== undefined && status !== 'complete') {
    return (
      <EmptyState
        title="Analysis is not finished yet"
        description="This run hasn't completed, so results aren't available yet."
        linkTo={`/analyze/${runId}`}
        linkLabel="View live progress"
      />
    );
  }

  if (results === undefined || isLoading) {
    return <ResultsLoadingSkeleton />;
  }

  const { meta, synthesis, auditLog, durationMs, summaries } = results;

  function handleDownloadAll(): void {
    if (runId === undefined) {
      return;
    }

    try {
      downloadResults(runId);
      toast({ title: 'Download started', description: 'All generated documents (ZIP)' });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Download failed',
        description: err instanceof Error ? err.message : 'Could not start the download.',
      });
    }
  }

  return (
    <div className="container grid grid-cols-1 gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{meta.name}</h1>
          <p className="text-sm text-muted-foreground">
            {meta.identifier} · commit {meta.commitHash.slice(0, 7)}
          </p>
        </header>

        <Tabs
          value={selectedDocumentationTab}
          onValueChange={(value) => setSelectedDocumentationTab(value as SelectedDocumentationTab)}
        >
          <TabsList>
            <TabsTrigger value="readme">README</TabsTrigger>
            <TabsTrigger value="architecture">ARCHITECTURE</TabsTrigger>
            <TabsTrigger value="onboarding">ONBOARDING</TabsTrigger>
            <TabsTrigger value="deep-dive">Deep Dive</TabsTrigger>
          </TabsList>

          <TabsContent value="readme" className="flex flex-col gap-4">
            <DocumentDownloadButton label="README" fileName="README.generated.md" markdown={synthesis.readme} />
            <DocumentMarkdown markdown={synthesis.readme} />
          </TabsContent>

          <TabsContent value="architecture" className="flex flex-col gap-4">
            <DocumentDownloadButton label="ARCHITECTURE" fileName="ARCHITECTURE.md" markdown={synthesis.architecture} />
            <DocumentMarkdown markdown={synthesis.architecture} enableMermaidDiagrams />
          </TabsContent>

          <TabsContent value="onboarding" className="flex flex-col gap-4">
            <DocumentDownloadButton label="ONBOARDING" fileName="ONBOARDING.md" markdown={synthesis.onboarding} />
            <DocumentMarkdown markdown={synthesis.onboarding} />
          </TabsContent>

          <TabsContent value="deep-dive">
            <Card>
              <CardHeader>
                <CardTitle>Deep Dive</CardTitle>
                <CardDescription>Chat-based investigation is coming in Task 20.</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Once available, you&apos;ll be able to ask follow-up questions about this repository
                here, with a live streaming reasoning trace.
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <aside className="flex flex-col gap-4">
        <RepositoryMetadataCard meta={meta} filesSummarizedCount={summaries.length} durationMs={durationMs} />
        <DetectedFrameworksCard frameworks={meta.frameworks} />

        <Card>
          <CardHeader>
            <CardTitle>Downloads</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <DocumentDownloadButton label="README" fileName="README.generated.md" markdown={synthesis.readme} />
            <DocumentDownloadButton label="ARCHITECTURE" fileName="ARCHITECTURE.md" markdown={synthesis.architecture} />
            <DocumentDownloadButton label="ONBOARDING" fileName="ONBOARDING.md" markdown={synthesis.onboarding} />
            <Button size="sm" onClick={handleDownloadAll}>
              Download All (ZIP)
            </Button>
          </CardContent>
        </Card>

        <AuditLogCard repositoryAuditEntries={auditLog} />
      </aside>
    </div>
  );
}
