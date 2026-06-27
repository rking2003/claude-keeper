import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition, type SessionState } from '@core/state';

describe('session state machine', () => {
  it('allows the happy-path limit/resume cycle', () => {
    const path: SessionState[] = [
      'IDLE',
      'RUNNING',
      'LIMIT_DETECTED',
      'WAITING',
      'RESUMING',
      'RUNNING',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('allows ERROR -> WAITING (retry/backoff) and RESUMING -> ERROR', () => {
    expect(canTransition('RESUMING', 'ERROR')).toBe(true);
    expect(canTransition('ERROR', 'WAITING')).toBe(true);
  });

  it('allows stopping to IDLE from any active state', () => {
    for (const s of ['RUNNING', 'LIMIT_DETECTED', 'WAITING', 'RESUMING', 'ERROR'] as SessionState[]) {
      expect(canTransition(s, 'IDLE')).toBe(true);
    }
  });

  it('rejects illegal jumps', () => {
    expect(canTransition('IDLE', 'RESUMING')).toBe(false);
    expect(canTransition('RUNNING', 'RESUMING')).toBe(false);
    expect(canTransition('WAITING', 'RUNNING')).toBe(false);
  });

  it('allows IDLE -> WAITING for cross-restart wait recovery', () => {
    expect(canTransition('IDLE', 'WAITING')).toBe(true);
  });

  it('assertTransition throws on illegal transitions', () => {
    expect(() => assertTransition('IDLE', 'RESUMING')).toThrowError(/Illegal session state transition/);
    expect(assertTransition('IDLE', 'RUNNING')).toBe('RUNNING');
  });
});
