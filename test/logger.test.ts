import { describe, it, expect, afterEach } from 'vitest';
import {
  configureLogger,
  createLogger,
  formatRecord,
  isVerbose,
  resetLogger,
  setVerbose,
  type LogRecord,
} from '../src/core/logger';

function capture() {
  const records: LogRecord[] = [];
  const lines: string[] = [];
  configureLogger({
    sinks: [
      (r, formatted) => {
        records.push(r);
        lines.push(formatted);
      },
    ],
  });
  return { records, lines };
}

afterEach(() => resetLogger());

describe('logger', () => {
  it('emits basic levels (info/warn/error) regardless of verbosity', () => {
    const { records } = capture();
    setVerbose(false);
    const log = createLogger('test');
    log.info('hi');
    log.warn('careful');
    log.error('boom');
    expect(records.map((r) => r.level)).toEqual(['info', 'warn', 'error']);
  });

  it('suppresses debug when verbose is off and emits it when on', () => {
    const { records } = capture();
    setVerbose(false);
    const log = createLogger('test');
    log.debug('quiet');
    expect(records).toHaveLength(0);

    setVerbose(true);
    log.debug('loud');
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('debug');
  });

  it('is silent when no sinks are configured', () => {
    resetLogger();
    const log = createLogger('test');
    // Should not throw and there is nothing to assert beyond no-crash.
    expect(() => {
      log.info('nobody listening');
      log.error('still nobody');
    }).not.toThrow();
  });

  it('carries the scope and structured data through to the record', () => {
    const { records } = capture();
    const log = createLogger('pty');
    log.info('spawning', { command: 'claude', args: ['--continue'] });
    expect(records[0]?.scope).toBe('pty');
    expect(records[0]?.data).toEqual({ command: 'claude', args: ['--continue'] });
  });

  it('child loggers append a nested scope', () => {
    const { records } = capture();
    createLogger('main').child('session').info('x');
    expect(records[0]?.scope).toBe('main:session');
  });

  it('formats a record as a single grep-friendly line including data', () => {
    const line = formatRecord({ ts: 0, level: 'info', scope: 'pty', msg: 'spawned', data: { pid: 42 } });
    expect(line).toContain('INFO');
    expect(line).toContain('[pty]');
    expect(line).toContain('spawned');
    expect(line).toContain('"pid":42');
  });

  it('formatRecord handles circular data without throwing', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    const line = formatRecord({ ts: 0, level: 'debug', scope: 's', msg: 'm', data: obj });
    expect(line).toContain('[Circular]');
  });

  it('configureLogger toggles verbose and reset clears it', () => {
    configureLogger({ verbose: true, sinks: [] });
    expect(isVerbose()).toBe(true);
    resetLogger();
    expect(isVerbose()).toBe(false);
  });
});
