import { EventEmitter } from 'node:events';

import type { HeartbeatEvent } from '../types';

export type { HeartbeatEvent } from '../types';

// Process-wide liveness signal shared between the rate limiter and
// pipeline.ts's stall watchdog: a rate-limited wait can legitimately run for
// tens of seconds with no `onProgress` stage transition, so this lets it
// announce "still alive, just waiting on budget" without threading a
// callback through every layer. Supplemental to, not a replacement for, the
// `onProgress` pattern CLAUDE.md requires of packages/core — plain
// `node:events`, no HTTP/UI assumption, and never used for user-facing progress.
class HeartbeatBus extends EventEmitter {
  pulse(source: string, detail?: string): void {
    const event: HeartbeatEvent = { source, detail, timestamp: Date.now() };

    this.emit('pulse', event);
  }
}

export const heartbeatBus = new HeartbeatBus();
