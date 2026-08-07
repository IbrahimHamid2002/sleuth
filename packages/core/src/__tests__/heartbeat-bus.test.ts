import { describe, expect, it } from 'vitest';

import { heartbeatBus, type HeartbeatEvent } from '../llm/heartbeat-bus';

describe('heartbeatBus', () => {
  it('emits a pulse event carrying source, detail, and a timestamp', () => {
    const received: HeartbeatEvent[] = [];
    const listener = (event: HeartbeatEvent): void => {
      received.push(event);
    };

    heartbeatBus.on('pulse', listener);

    try {
      const before = Date.now();

      heartbeatBus.pulse('rate-limiter', 'waiting for budget');

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ source: 'rate-limiter', detail: 'waiting for budget' });
      expect(received[0]!.timestamp).toBeGreaterThanOrEqual(before);
    } finally {
      heartbeatBus.off('pulse', listener);
    }
  });

  it('omits detail as undefined when none is given', () => {
    const received: HeartbeatEvent[] = [];
    const listener = (event: HeartbeatEvent): void => {
      received.push(event);
    };

    heartbeatBus.on('pulse', listener);

    try {
      heartbeatBus.pulse('discovery');

      expect(received[0]?.detail).toBeUndefined();
    } finally {
      heartbeatBus.off('pulse', listener);
    }
  });

  it('delivers a single pulse to every registered listener', () => {
    let firstCount = 0;
    let secondCount = 0;
    const first = (): void => {
      firstCount += 1;
    };
    const second = (): void => {
      secondCount += 1;
    };

    heartbeatBus.on('pulse', first);
    heartbeatBus.on('pulse', second);

    try {
      heartbeatBus.pulse('summarization');

      expect(firstCount).toBe(1);
      expect(secondCount).toBe(1);
    } finally {
      heartbeatBus.off('pulse', first);
      heartbeatBus.off('pulse', second);
    }
  });
});
