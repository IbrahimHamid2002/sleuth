import { MoonStarIcon, SunMediumIcon } from '@animateicons/react/lucide';
import { AnimatePresence, motion } from 'motion/react';

import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';

const THEME_TOGGLE_ICON_TRANSITION = { duration: 0.2 };

export function ModeToggle(): React.JSX.Element {
  const { resolvedTheme, setTheme } = useTheme();

  const toggleResolvedTheme = (): void => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={toggleResolvedTheme}
      className="relative overflow-hidden"
    >
      <AnimatePresence mode="wait" initial={false}>
        {resolvedTheme === 'dark' ? (
          <motion.span
            key="moon-star-icon"
            initial={{ opacity: 0, rotate: -90, scale: 0.5 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 90, scale: 0.5 }}
            transition={THEME_TOGGLE_ICON_TRANSITION}
            className="flex"
          >
            <MoonStarIcon size={20} />
          </motion.span>
        ) : (
          <motion.span
            key="sun-medium-icon"
            initial={{ opacity: 0, rotate: 90, scale: 0.5 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: -90, scale: 0.5 }}
            transition={THEME_TOGGLE_ICON_TRANSITION}
            className="flex"
          >
            <SunMediumIcon size={20} />
          </motion.span>
        )}
      </AnimatePresence>
    </Button>
  );
}
