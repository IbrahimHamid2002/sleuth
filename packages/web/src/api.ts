import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { z } from 'zod';

// Base URL resolution: VITE_API_URL is treated as the *complete* API base
// (including `/api`, e.g. `http://localhost:3000/api`) so every endpoint
// path below is a bare resource path (`/analyze`, not `/api/analyze`) —
// appending `/api` here too would duplicate it into `/api/api`.
export const sleuthApiBaseUrl: string = import.meta.env.VITE_API_URL ?? '/api';

// ---- Response schemas, mirroring @sleuth/api's actual contracts -----------
// (packages/api/src/routes/analyze.ts, packages/api/src/routes/sessions.ts,
// packages/core/src/types.ts) rather than an invented shape.

const analyzeRepoResponseSchema = z.object({ runId: z.string() });

const runProgressSchema = z.object({
  stage: z.string(),
  detail: z.string().optional(),
});

const runStatusResponseSchema = z.object({
  status: z.enum(['running', 'complete', 'error']),
  progress: runProgressSchema,
  error: z.string().optional(),
});

const subProjectProfileSchema = z.object({
  rootRelativePath: z.string(),
  frameworks: z.array(z.string()),
  packageManager: z.enum(['npm', 'yarn', 'pnpm']),
  entryPoints: z.array(z.string()),
});

const repoMetaSchema = z.object({
  name: z.string(),
  identifier: z.string(),
  commitHash: z.string(),
  rootPath: z.string(),
  frameworks: z.array(z.string()),
  isMonorepo: z.boolean(),
  monorepoType: z.enum(['workspace', 'ad-hoc', 'none']),
  workspaceDirs: z.array(z.string()),
  packageManager: z.enum(['npm', 'yarn', 'pnpm']),
  subProjects: z.array(subProjectProfileSchema),
});

const synthesisResultSchema = z.object({
  readme: z.string(),
  architecture: z.string(),
  onboarding: z.string(),
});

const fileSummarySchema = z.object({
  path: z.string(),
  purpose: z.string(),
  exports: z.array(z.string()),
  dependencies: z.array(z.string()),
  summary: z.string(),
});

const auditEntrySchema = z.object({
  timestamp: z.number(),
  stage: z.string(),
  action: z.string(),
  detail: z.string(),
});

const runResultsResponseSchema = z.object({
  meta: repoMetaSchema,
  synthesis: synthesisResultSchema,
  summaries: z.array(fileSummarySchema),
  auditLog: z.array(auditEntrySchema),
  durationMs: z.number(),
});

const startSessionResponseSchema = z.object({ sessionId: z.string() });

const askQuestionResponseSchema = z.object({ investigationId: z.string() });

const endSessionResponseSchema = z.object({ success: z.literal(true) });

export type AnalyzeRepoResponse = z.infer<typeof analyzeRepoResponseSchema>;
export type RunProgress = z.infer<typeof runProgressSchema>;
export type RunStatusResponse = z.infer<typeof runStatusResponseSchema>;
export type RepoMeta = z.infer<typeof repoMetaSchema>;
export type SynthesisResult = z.infer<typeof synthesisResultSchema>;
export type FileSummary = z.infer<typeof fileSummarySchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type RunResultsResponse = z.infer<typeof runResultsResponseSchema>;
export type StartSessionResponse = z.infer<typeof startSessionResponseSchema>;
export type AskQuestionResponse = z.infer<typeof askQuestionResponseSchema>;
export type EndSessionResponse = z.infer<typeof endSessionResponseSchema>;

export interface AnalyzeRepoRequest {
  url: string;
  pat?: string;
}

export interface StartSessionRequest {
  runId: string;
}

export interface AskQuestionRequest {
  sessionId: string;
  question: string;
}

// Shared response-validation gate: every endpoint below routes its raw JSON
// through here before RTK Query hands it to UI code, so a malformed payload
// surfaces as a descriptive query error instead of silently reaching a
// component with the wrong shape.
function validateApiResponse<ResponseShape>(
  responseSchema: z.ZodType<ResponseShape>,
  rawResponse: unknown,
  endpointLabel: string,
): ResponseShape {
  const parseResult = responseSchema.safeParse(rawResponse);

  if (!parseResult.success) {
    throw new Error(`Sleuth API returned an unexpected response shape for ${endpointLabel}: ${parseResult.error.message}`);
  }

  return parseResult.data;
}

export const sleuthApi = createApi({
  reducerPath: 'sleuthApi',
  baseQuery: fetchBaseQuery({ baseUrl: sleuthApiBaseUrl }),
  endpoints: (builder) => ({
    analyzeRepo: builder.mutation<AnalyzeRepoResponse, AnalyzeRepoRequest>({
      query: (analyzeRepoRequest) => ({
        url: '/analyze',
        method: 'POST',
        body: analyzeRepoRequest,
      }),
      transformResponse: (rawResponse: unknown) => validateApiResponse(analyzeRepoResponseSchema, rawResponse, 'analyzeRepo'),
    }),
    getRunStatus: builder.query<RunStatusResponse, string>({
      query: (runId) => `/runs/${runId}/status`,
      transformResponse: (rawResponse: unknown) => validateApiResponse(runStatusResponseSchema, rawResponse, 'getRunStatus'),
    }),
    getRunResults: builder.query<RunResultsResponse, string>({
      query: (runId) => `/runs/${runId}/results`,
      transformResponse: (rawResponse: unknown) => validateApiResponse(runResultsResponseSchema, rawResponse, 'getRunResults'),
    }),
    startSession: builder.mutation<StartSessionResponse, StartSessionRequest>({
      query: (startSessionRequest) => ({
        url: '/sessions/start',
        method: 'POST',
        body: startSessionRequest,
      }),
      transformResponse: (rawResponse: unknown) => validateApiResponse(startSessionResponseSchema, rawResponse, 'startSession'),
    }),
    askQuestion: builder.mutation<AskQuestionResponse, AskQuestionRequest>({
      query: ({ sessionId, question }) => ({
        url: `/sessions/${sessionId}/ask`,
        method: 'POST',
        body: { question },
      }),
      transformResponse: (rawResponse: unknown) => validateApiResponse(askQuestionResponseSchema, rawResponse, 'askQuestion'),
    }),
    endSession: builder.mutation<EndSessionResponse, string>({
      query: (sessionId) => ({
        url: `/sessions/${sessionId}/end`,
        method: 'POST',
      }),
      transformResponse: (rawResponse: unknown) => validateApiResponse(endSessionResponseSchema, rawResponse, 'endSession'),
    }),
  }),
});

export const {
  useAnalyzeRepoMutation,
  useGetRunStatusQuery,
  useGetRunResultsQuery,
  useLazyGetRunResultsQuery,
  useStartSessionMutation,
  useAskQuestionMutation,
  useEndSessionMutation,
} = sleuthApi;

// Not an RTK Query endpoint: the ZIP must stream straight to the browser's
// download machinery via a real navigation, not through the fetch/JSON path
// RTK Query endpoints assume.
export function downloadResults(runId: string): void {
  const downloadAnchor = document.createElement('a');

  downloadAnchor.href = `${sleuthApiBaseUrl}/runs/${runId}/download`;
  downloadAnchor.rel = 'noopener';
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  document.body.removeChild(downloadAnchor);
}
