import { useEffect, useState } from 'react';
import type { SerializedError } from '@reduxjs/toolkit';
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query/react';
import { skipToken } from '@reduxjs/toolkit/query/react';

import type {
  AnalyzeRepoRequest,
  AnalyzeRepoResponse,
  RunProgress,
  RunResultsResponse,
  RunStatusResponse,
} from '@/api';
import { useAnalyzeRepoMutation, useGetRunResultsQuery, useGetRunStatusQuery } from '@/api';

const RUN_STATUS_POLLING_INTERVAL_MS = 2000;
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatusResponse['status']> = new Set(['complete', 'error']);

export interface UseAnalysisResult {
  status: RunStatusResponse['status'] | undefined;
  progress: RunProgress | undefined;
  results: RunResultsResponse | undefined;
  error: string | undefined;
  isLoading: boolean;
  startAnalysis: (analyzeRepoRequest: AnalyzeRepoRequest) => Promise<AnalyzeRepoResponse>;
}

function describeQueryError(queryError: FetchBaseQueryError | SerializedError | undefined): string | undefined {
  if (queryError === undefined) {
    return undefined;
  }

  if ('status' in queryError) {
    return typeof queryError.data === 'string' ? queryError.data : `Request failed with status ${String(queryError.status)}`;
  }

  return queryError.message ?? 'Unknown Sleuth API error';
}

// Thin composition layer over the RTK Query hooks: server-state (run status,
// run results, the analyze request) lives entirely in RTK Query's cache —
// this hook only derives read-only view values and the single piece of
// client-only state needed to gate polling (see shouldPollRunStatus below).
export function useAnalysis(runId?: string): UseAnalysisResult {
  const [analyzeRepo, analyzeRepoMutationState] = useAnalyzeRepoMutation();
  const [shouldPollRunStatus, setShouldPollRunStatus] = useState(true);

  useEffect(() => {
    setShouldPollRunStatus(true);
  }, [runId]);

  const runStatusQueryResult = useGetRunStatusQuery(runId ?? skipToken, {
    pollingInterval: shouldPollRunStatus ? RUN_STATUS_POLLING_INTERVAL_MS : 0,
  });

  const repositoryAnalysisStatus = runStatusQueryResult.data?.status;

  useEffect(() => {
    if (repositoryAnalysisStatus !== undefined && TERMINAL_RUN_STATUSES.has(repositoryAnalysisStatus)) {
      setShouldPollRunStatus(false);
    }
  }, [repositoryAnalysisStatus]);

  const shouldFetchRunResults = runId !== undefined && repositoryAnalysisStatus === 'complete';

  const runResultsQueryResult = useGetRunResultsQuery(shouldFetchRunResults ? runId : skipToken);

  const combinedErrorMessage =
    describeQueryError(runStatusQueryResult.error) ??
    describeQueryError(runResultsQueryResult.error) ??
    describeQueryError(analyzeRepoMutationState.error);

  async function startAnalysis(analyzeRepoRequest: AnalyzeRepoRequest): Promise<AnalyzeRepoResponse> {
    return analyzeRepo(analyzeRepoRequest).unwrap();
  }

  return {
    status: repositoryAnalysisStatus,
    progress: runStatusQueryResult.data?.progress,
    results: runResultsQueryResult.data,
    error: combinedErrorMessage,
    isLoading: analyzeRepoMutationState.isLoading || runStatusQueryResult.isLoading || runResultsQueryResult.isLoading,
    startAnalysis,
  };
}
