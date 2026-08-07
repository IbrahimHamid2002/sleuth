import { useId, useState } from 'react';
import { InfoIcon } from '@animateicons/react/lucide';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAnalyzeRepoMutation } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';

// Mirrors @sleuth/core's RepoInputSchema github-URL regex (packages/core/src/schemas.ts)
// so an obviously invalid URL is caught before it ever reaches the API.
const GITHUB_REPOSITORY_URL_PATTERN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;
const PAT_HELP_TEXT = 'Never stored, only used for this request';

// This Card's title is the only heading on the page, so it's rendered as a
// real <h1> instead of the shadcn CardTitle div.
function WebPageHeading({ children }: { children: string }): React.JSX.Element {
  return <h1 className="font-semibold leading-none tracking-tight">{children}</h1>;
}

function validateRepositoryUrl(candidateRepositoryUrl: string): string | undefined {
  if (candidateRepositoryUrl.length === 0) {
    return 'Enter a repository URL.';
  }

  if (!GITHUB_REPOSITORY_URL_PATTERN.test(candidateRepositoryUrl)) {
    return 'Enter a valid GitHub repository URL, e.g. https://github.com/owner/repo';
  }

  return undefined;
}

export function WebPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [analyzeRepo, analyzeRepoMutationState] = useAnalyzeRepoMutation();

  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [repositoryUrlValidationError, setRepositoryUrlValidationError] = useState<string | undefined>(undefined);
  const [isPrivateRepositorySectionExpanded, setIsPrivateRepositorySectionExpanded] = useState(false);
  const [personalAccessToken, setPersonalAccessToken] = useState('');

  const repositoryUrlInputId = useId();
  const repositoryUrlErrorId = useId();
  const personalAccessTokenInputId = useId();
  const personalAccessTokenHelpId = useId();
  const privateRepositorySectionContentId = useId();

  const isSubmitDisabled = analyzeRepoMutationState.isLoading;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const trimmedRepositoryUrl = repositoryUrl.trim();
    const validationError = validateRepositoryUrl(trimmedRepositoryUrl);

    setRepositoryUrlValidationError(validationError);

    if (validationError !== undefined) {
      return;
    }

    const trimmedPersonalAccessToken = personalAccessToken.trim();

    try {
      const { runId } = await analyzeRepo({
        url: trimmedRepositoryUrl,
        pat: trimmedPersonalAccessToken.length > 0 ? trimmedPersonalAccessToken : undefined,
      }).unwrap();

      navigate(`/analyze/${runId}`);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not start analysis',
        description: err instanceof Error ? err.message : 'The Sleuth API returned an unexpected error.',
      });
    } finally {
      // PAT must never outlive this single request — cleared on both the
      // success and failure paths, and the mutation state is reset so a
      // failed attempt doesn't leave stale error/loading UI behind if the
      // user navigates back to this form later.
      setPersonalAccessToken('');
      analyzeRepoMutationState.reset();
    }
  }

  return (
    <div id="main-content" tabIndex={-1} className="container flex justify-center py-12">
      {/* min-w-0 overrides the flex item's default min-width:auto, which
         otherwise refuses to shrink below the card's content width and
         pushes the card (and page) past narrow viewports. */}
      <Card className="w-full min-w-0 max-w-xl">
        <CardHeader>
          <WebPageHeading>Analyze a repository</WebPageHeading>
          <CardDescription>
            Enter a public or private GitHub repository URL to generate README, ARCHITECTURE, and
            ONBOARDING documentation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form noValidate onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <label htmlFor={repositoryUrlInputId} className="text-sm font-medium">
                Repository URL <span aria-hidden="true">*</span>
                <span className="sr-only"> (required)</span>
              </label>
              <Input
                id={repositoryUrlInputId}
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder="https://github.com/owner/repo"
                value={repositoryUrl}
                disabled={isSubmitDisabled}
                aria-required="true"
                aria-invalid={repositoryUrlValidationError !== undefined}
                aria-describedby={repositoryUrlValidationError !== undefined ? repositoryUrlErrorId : undefined}
                className={
                  repositoryUrlValidationError !== undefined ? 'border-red-700 dark:border-red-300' : undefined
                }
                onChange={(event) => {
                  setRepositoryUrl(event.target.value);

                  if (repositoryUrlValidationError !== undefined) {
                    setRepositoryUrlValidationError(undefined);
                  }
                }}
              />
              {repositoryUrlValidationError !== undefined && (
                <p id={repositoryUrlErrorId} role="alert" className="text-sm text-red-700 dark:text-red-300">
                  {repositoryUrlValidationError}
                </p>
              )}
            </div>

            <Collapsible open={isPrivateRepositorySectionExpanded} onOpenChange={setIsPrivateRepositorySectionExpanded}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-fit px-0"
                  aria-expanded={isPrivateRepositorySectionExpanded}
                  aria-controls={privateRepositorySectionContentId}
                >
                  Private repo?
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent id={privateRepositorySectionContentId} className="flex flex-col gap-2 pt-3">
                <div className="flex items-center gap-1.5">
                  <label htmlFor={personalAccessTokenInputId} className="text-sm font-medium">
                    Personal Access Token
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="About the Personal Access Token field"
                        className="inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <InfoIcon size={14} aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{PAT_HELP_TEXT}</TooltipContent>
                  </Tooltip>
                </div>
                <Input
                  id={personalAccessTokenInputId}
                  type="password"
                  autoComplete="off"
                  placeholder="ghp_..."
                  value={personalAccessToken}
                  disabled={isSubmitDisabled}
                  aria-describedby={personalAccessTokenHelpId}
                  onChange={(event) => setPersonalAccessToken(event.target.value)}
                />
                <p id={personalAccessTokenHelpId} className="text-xs text-muted-foreground">
                  {PAT_HELP_TEXT}
                </p>
              </CollapsibleContent>
            </Collapsible>

            <Button type="submit" disabled={isSubmitDisabled} aria-live="polite">
              {isSubmitDisabled ? 'Analyzing repository…' : 'Analyze repository'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
