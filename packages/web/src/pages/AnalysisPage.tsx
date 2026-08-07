import { useEffect } from 'react';
import { motion } from 'motion/react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { useAnalysis } from '@/hooks/useAnalysis';

interface PipelineStepperStage {
  label: string;
  // Raw @sleuth/core pipeline stage names (packages/core/src/pipeline.ts)
  // that this display step represents — the API's progress.stage is one of
  // these low-level values, never the display label itself.
  rawStages: readonly string[];
}

const PIPELINE_STEPPER_STAGES: readonly PipelineStepperStage[] = [
  { label: 'Clone', rawStages: ['queued', 'validate', 'sandbox', 'ingest'] },
  { label: 'Framework Detect', rawStages: ['frameworks'] },
  { label: 'Discover', rawStages: ['discovery'] },
  { label: 'Score', rawStages: ['indexing', 'prioritization'] },
  { label: 'Summarize', rawStages: ['summarization'] },
  { label: 'Synthesize', rawStages: ['synthesis'] },
  { label: 'Done', rawStages: ['complete'] },
];

const SUMMARIZATION_PROGRESS_PATTERN = /(\d+)\/(\d+) files summarized/;

function currentStepperIndex(rawStage: string | undefined): number {
  if (rawStage === undefined) {
    return 0;
  }

  const index = PIPELINE_STEPPER_STAGES.findIndex((step) => step.rawStages.includes(rawStage));

  return index === -1 ? 0 : index;
}

function summarizationPercentage(rawStage: string | undefined, detail: string | undefined): number {
  const summarizeIndex = PIPELINE_STEPPER_STAGES.findIndex((step) => step.label === 'Summarize');
  const stageIndex = currentStepperIndex(rawStage);

  if (stageIndex > summarizeIndex) {
    return 100;
  }

  if (stageIndex < summarizeIndex || detail === undefined) {
    return 0;
  }

  const match = SUMMARIZATION_PROGRESS_PATTERN.exec(detail);

  if (match === null) {
    return 0;
  }

  const [, completedRaw, totalRaw] = match;
  const completed = Number(completedRaw);
  const total = Number(totalRaw);

  return total > 0 ? Math.round((completed / total) * 100) : 0;
}

export function AnalysisPage(): React.JSX.Element {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { status, progress, error } = useAnalysis(runId);

  const isRunIdMissing = runId === undefined || runId.length === 0;

  useEffect(() => {
    if (status === 'complete' && runId !== undefined) {
      navigate(`/results/${runId}`, { replace: true });
    }
  }, [status, runId, navigate]);

  useEffect(() => {
    if (error !== undefined) {
      toast({ variant: 'destructive', title: 'Analysis failed', description: error });
    }
  }, [error, toast]);

  if (isRunIdMissing) {
    return (
      <div className="container flex justify-center py-16">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>No analysis run specified</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            This page needs a run ID in the URL. Start a new analysis from the{' '}
            <Link to="/web" className="underline underline-offset-4">
              Analyze
            </Link>{' '}
            page.
          </CardContent>
        </Card>
      </div>
    );
  }

  const activeStepIndex = currentStepperIndex(progress?.stage);
  const percentage = summarizationPercentage(progress?.stage, progress?.detail);

  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Analyzing repository</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          <ol className="flex flex-wrap gap-x-2 gap-y-4 sm:flex-nowrap sm:justify-between" aria-label="Analysis pipeline stages">
            {PIPELINE_STEPPER_STAGES.map((step, index) => {
              const isCurrent = index === activeStepIndex && status !== 'error';
              const isComplete = index < activeStepIndex || status === 'complete';

              return (
                <li key={step.label} className="flex flex-1 flex-col items-center gap-2 text-center">
                  <motion.div
                    animate={isCurrent ? { scale: [1, 1.12, 1] } : { scale: 1 }}
                    transition={isCurrent ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
                    className={
                      'flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold ' +
                      (isComplete
                        ? 'border-primary bg-primary text-primary-foreground'
                        : isCurrent
                          ? 'border-primary text-primary'
                          : 'border-muted-foreground/30 text-muted-foreground')
                    }
                  >
                    {index + 1}
                  </motion.div>
                  <span
                    className={
                      'text-xs font-medium sm:text-sm ' +
                      (isCurrent || isComplete ? 'text-foreground' : 'text-muted-foreground')
                    }
                  >
                    {step.label}
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm">
              <span>
                Current stage: <span className="font-medium text-foreground">{PIPELINE_STEPPER_STAGES[activeStepIndex]?.label}</span>
              </span>
              <span aria-hidden="true">{percentage}%</span>
            </div>
            <Progress value={percentage} aria-label="Summarization progress" aria-valuetext={`${percentage}% of files summarized`} />
            {progress?.detail !== undefined && <p className="text-xs text-muted-foreground">{progress.detail}</p>}
          </div>

          {status === 'error' && (
            <p role="alert" className="text-sm text-destructive">
              {error ?? 'The analysis run failed.'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
