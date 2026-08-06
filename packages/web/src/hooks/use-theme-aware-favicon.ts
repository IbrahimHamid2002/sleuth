import { useEffect } from 'react';

import { useTheme } from '@/components/theme-provider';

const FAVICON_LINK_ELEMENT_ID = 'favicon-link';

const FAVICON_HREF_BY_RESOLVED_THEME: Record<'light' | 'dark', string> = {
  light: '/favicon-blue.ico',
  dark: '/favicon-cream.ico',
};

/** Tracks which favicon hrefs we've already HEAD-checked, so a missing asset only warns once per href. */
const faviconHrefsWarnedAsMissing = new Set<string>();

export function useThemeAwareFavicon(): void {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const faviconLinkElement = document.getElementById(FAVICON_LINK_ELEMENT_ID);

    if (!(faviconLinkElement instanceof HTMLLinkElement)) {
      return;
    }

    const faviconHref = FAVICON_HREF_BY_RESOLVED_THEME[resolvedTheme];

    faviconLinkElement.href = faviconHref;

    if (faviconHrefsWarnedAsMissing.has(faviconHref)) {
      return;
    }

    fetch(faviconHref, { method: 'HEAD' })
      .then((response) => {
        if (!response.ok) {
          faviconHrefsWarnedAsMissing.add(faviconHref);
          console.warn(
            `[Sleuth] Favicon asset "${faviconHref}" is missing — see packages/web/public/ASSETS_TODO.md.`,
          );
        }
      })
      .catch(() => undefined);
  }, [resolvedTheme]);
}
