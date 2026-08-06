import { motion, useReducedMotion } from 'motion/react';
import { Link } from 'react-router-dom';

import { BorderBeam } from '@/components/ui/border-beam';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const HERO_ENTRANCE_TRANSITION = { duration: 0.5, ease: 'easeOut' } as const;

export function LandingPage(): React.JSX.Element {
  const prefersReducedMotion = useReducedMotion();

  const heroEntranceInitial = prefersReducedMotion ? false : { opacity: 0, y: 16 };
  const heroEntranceAnimate = { opacity: 1, y: 0 };

  return (
    <div className="container flex flex-col items-center gap-16 py-16 sm:py-24">
      <motion.div
        initial={heroEntranceInitial}
        animate={heroEntranceAnimate}
        transition={HERO_ENTRANCE_TRANSITION}
        className="w-full max-w-3xl"
      >
        <Card className="relative overflow-hidden border-2">
          <BorderBeam size={200} duration={10} colorFrom="hsl(var(--primary))" colorTo="hsl(var(--ring))" />
          <CardContent className="flex flex-col items-center gap-6 px-6 py-14 text-center sm:px-12">
            <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">Sleuth</h1>
            <p className="text-lg font-medium text-muted-foreground sm:text-xl">
              The Autonomous Codebase Detective
            </p>
            <p className="max-w-xl text-balance text-sm text-muted-foreground sm:text-base">
              Point Sleuth at any repository and it clones, analyzes, and documents it end to
              end — producing a README, an ARCHITECTURE overview, and an ONBOARDING guide, all
              generated from the actual code. Once the docs are ready, ask Sleuth&apos;s Deep Dive
              agent follow-up questions and it will investigate the source to answer them.
            </p>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <Button asChild size="lg">
                <Link to="/web">Get Started</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/docs">Docs</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
