import { useEffect, useState } from 'react';
import { GithubIcon } from '@animateicons/react/lucide';
import { useReducedMotion } from 'motion/react';

import logoBlue from '@/assets/img/logo-blue.png';
import logoCream from '@/assets/img/logo-cream.png';
import { ModeToggle } from '@/components/mode-toggle';
import { useTheme } from '@/components/theme-provider';
import { useThemeAwareFavicon } from '@/hooks/use-theme-aware-favicon';

const SLEUTH_GITHUB_REPO_URL: string = import.meta.env.VITE_GITHUB_REPO_URL ?? '';

const NAVBAR_LOGO_SRC_BY_RESOLVED_THEME: Record<'light' | 'dark', string> = {
  light: logoBlue,
  dark: logoCream,
};

// Logo PNGs' real pixel dimensions — set as HTML attributes (distinct from the
// `h-8 w-auto` Tailwind classes that control rendered size) purely so the
// browser can reserve the correct aspect ratio before the image loads and
// avoid layout shift.
const NAVBAR_LOGO_NATURAL_WIDTH = 1024;
const NAVBAR_LOGO_NATURAL_HEIGHT = 1536;

export function Navbar(): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  const prefersReducedMotion = useReducedMotion();

  useThemeAwareFavicon();

  const navbarLogoSrc = NAVBAR_LOGO_SRC_BY_RESOLVED_THEME[resolvedTheme];
  const [isNavbarLogoImageMissing, setIsNavbarLogoImageMissing] = useState(false);

  // A theme switch means a different logo file, which deserves its own fresh load attempt.
  useEffect(() => {
    setIsNavbarLogoImageMissing(false);
  }, [navbarLogoSrc]);

  const handleNavbarLogoImageError = (): void => {
    console.warn(
      `[Sleuth] Logo asset "${navbarLogoSrc}" failed to load. Falling back to text wordmark.`,
    );
    setIsNavbarLogoImageMissing(true);
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Skip to main content
      </a>
      <nav aria-label="Main" className="container flex h-16 items-center justify-between">
        <a
          href="/"
          aria-label="Sleuth home"
          className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {isNavbarLogoImageMissing ? (
            <span className="text-lg font-bold tracking-wide">Sleuth</span>
          ) : (
            <img
              src={navbarLogoSrc}
              alt=""
              width={NAVBAR_LOGO_NATURAL_WIDTH}
              height={NAVBAR_LOGO_NATURAL_HEIGHT}
              className="h-8 w-auto"
              onError={handleNavbarLogoImageError}
            />
          )}
        </a>

        <div className="flex items-center gap-2">
          <ModeToggle />
          <a
            href={SLEUTH_GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source on GitHub (opens in a new tab)"
            className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <GithubIcon size={20} aria-hidden="true" isAnimated={!prefersReducedMotion} />
          </a>
        </div>
      </nav>
    </header>
  );
}
