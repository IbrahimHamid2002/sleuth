import type { DeepDiveSession } from '@sleuth/core';
import { terminateSession } from '@sleuth/core';

const REAP_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function startSessionReaper(sessions: Map<string, DeepDiveSession>): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();

    for (const [sessionId, session] of sessions) {
      if (now - session.lastActivityAt > IDLE_TIMEOUT_MS) {
        sessions.delete(sessionId);

        void terminateSession(session).then(() => {
          console.log(`Reaped idle Deep Dive session ${sessionId}`);
        });
      }
    }
  }, REAP_INTERVAL_MS);
}
