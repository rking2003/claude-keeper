/**
 * Core session state machine types (pure, Electron-free, unit-tested).
 *
 * IDLE -> RUNNING -> LIMIT_DETECTED -> WAITING -> RESUMING -> RUNNING
 *                                         \-> ERROR (after maxRetries) -> WAITING
 *
 * RUNNING -> WAITING is also reached directly when the user arms a manual resume
 * timer from a live session (no limit involved).
 */
export type SessionState =
  | 'IDLE'
  | 'RUNNING'
  | 'LIMIT_DETECTED'
  | 'WAITING'
  | 'RESUMING'
  | 'ERROR';

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  // IDLE -> WAITING is only used by cross-restart recovery (recoverWaiting),
  // which re-enters a persisted wait without a live RUNNING session first.
  IDLE: ['RUNNING', 'WAITING'],
  RUNNING: ['LIMIT_DETECTED', 'WAITING', 'ERROR', 'IDLE'],
  LIMIT_DETECTED: ['WAITING', 'IDLE'],
  WAITING: ['RESUMING', 'ERROR', 'IDLE'],
  RESUMING: ['RUNNING', 'WAITING', 'ERROR', 'IDLE'],
  ERROR: ['WAITING', 'RESUMING', 'IDLE'],
};

/** Returns true if `to` is a legal next state from `from`. */
export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws if the transition is illegal; otherwise returns `to`. */
export function assertTransition(from: SessionState, to: SessionState): SessionState {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal session state transition: ${from} -> ${to}`);
  }
  return to;
}
