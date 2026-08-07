import { MoonStarIcon, SunMediumIcon } from '@animateicons/react/lucide';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';

const THEME_TOGGLE_ICON_TRANSITION = { duration: 0.2 };
const THEME_TOGGLE_ICON_LABEL_BY_RESOLVED_THEME: Record<'light' | 'dark', string> = {
  light: 'Switch to dark mode',
  dark: 'Switch to light mode',
};

export function ModeToggle(): React.JSX.Element {
  const { resolvedTheme, setTheme } = useTheme();
  const prefersReducedMotion = useReducedMotion();

  const toggleResolvedTheme = (): void => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  // Reduced motion keeps the icon swap as a plain crossfade — no rotate/scale.
  const iconEnterState = prefersReducedMotion ? { opacity: 0 } : { opacity: 0, rotate: -90, scale: 0.5 };
  const iconVisibleState = prefersReducedMotion ? { opacity: 1 } : { opacity: 1, rotate: 0, scale: 1 };
  const iconExitState = prefersReducedMotion ? { opacity: 0 } : { opacity: 0, rotate: 90, scale: 0.5 };

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={THEME_TOGGLE_ICON_LABEL_BY_RESOLVED_THEME[resolvedTheme]}
      onClick={toggleResolvedTheme}
      className="relative h-11 w-11 overflow-hidden"
    >
      <AnimatePresence mode="wait" initial={false}>
        {resolvedTheme === 'dark' ? (
          <motion.span
            key="moon-star-icon"
            initial={iconEnterState}
            animate={iconVisibleState}
            exit={iconExitState}
            transition={THEME_TOGGLE_ICON_TRANSITION}
            className="flex"
          >
            <MoonStarIcon size={20} aria-hidden="true" isAnimated={!prefersReducedMotion} />
          </motion.span>
        ) : (
          <motion.span
            key="sun-medium-icon"
            initial={iconEnterState}
            animate={iconVisibleState}
            exit={iconExitState}
            transition={THEME_TOGGLE_ICON_TRANSITION}
            className="flex"
          >
            <SunMediumIcon size={20} aria-hidden="true" isAnimated={!prefersReducedMotion} />
          </motion.span>
        )}
      </AnimatePresence>
    </Button>
  );
}
