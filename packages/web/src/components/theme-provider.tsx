import { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

interface ThemeProviderState {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const SLEUTH_THEME_STORAGE_KEY = 'sleuth-ui-theme';

const initialThemeProviderState: ThemeProviderState = {
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => undefined,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialThemeProviderState);

function getSystemResolvedTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = SLEUTH_THEME_STORAGE_KEY,
}: ThemeProviderProps): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme | null) ?? defaultTheme,
  );

  const resolvedTheme: ResolvedTheme = theme === 'system' ? getSystemResolvedTheme() : theme;

  useEffect(() => {
    const rootElement = window.document.documentElement;

    rootElement.classList.remove('light', 'dark');
    rootElement.classList.add(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = (nextTheme: Theme): void => {
    localStorage.setItem(storageKey, nextTheme);
    setThemeState(nextTheme);
  };

  const contextValue = useMemo<ThemeProviderState>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme],
  );

  return (
    <ThemeProviderContext.Provider value={contextValue}>{children}</ThemeProviderContext.Provider>
  );
}

export function useTheme(): ThemeProviderState {
  const context = useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
}
