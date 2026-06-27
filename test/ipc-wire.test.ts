import { describe, it, expect } from 'vitest';
import { toWireEvent } from '../src/shared/ipc';
import type { ControllerEvent } from '@core/session-controller';

describe('toWireEvent', () => {
  it('converts a limit event Date into epoch millis', () => {
    const d = new Date('2026-06-26T15:00:00.000Z');
    const wire = toWireEvent({ type: 'limit', resetTime: d, matchedText: 'usage limit reached' });
    expect(wire).toEqual({ type: 'limit', resetTimeMs: d.getTime(), matchedText: 'usage limit reached' });
  });

  it('maps a null reset time to null millis', () => {
    const wire = toWireEvent({ type: 'limit', resetTime: null, matchedText: 'x' });
    expect(wire).toEqual({ type: 'limit', resetTimeMs: null, matchedText: 'x' });
  });

  it('passes non-limit events through unchanged', () => {
    const cases: ControllerEvent[] = [
      { type: 'state', state: 'RUNNING' },
      { type: 'data', data: 'hello' },
      { type: 'countdown', remainingMs: 1000, targetMs: 5000 },
      { type: 'resuming', attempt: 2, strategy: 'continue' },
      { type: 'resumed' },
      { type: 'error', message: 'boom' },
      { type: 'exit', exitCode: 0 },
    ];
    for (const ev of cases) {
      expect(toWireEvent(ev)).toEqual(ev);
    }
  });
});
