import * as pty from '@lydell/node-pty';
import { createLogger } from '../core/logger';
import { buildSpawnSpec } from './resolve-command';

const log = createLogger('pty');

export interface PtyStartOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export type PtyDataHandler = (data: string) => void;
export type PtyExitHandler = (info: { exitCode: number; signal?: number }) => void;

/**
 * Electron-free wrapper around @lydell/node-pty. Owns a single child PTY and
 * fans out data/exit events to any number of subscribers. Kept free of Electron
 * imports so it can be exercised directly in integration tests with a real PTY.
 */
export class PtyHost {
  private term: pty.IPty | undefined;
  private readonly dataHandlers = new Set<PtyDataHandler>();
  private readonly exitHandlers = new Set<PtyExitHandler>();

  get running(): boolean {
    return this.term !== undefined;
  }

  get pid(): number | undefined {
    return this.term?.pid;
  }

  start(opts: PtyStartOptions): void {
    if (this.term) {
      throw new Error('PtyHost already running; call kill() before start()');
    }
    const env = opts.env ?? sanitizeEnv(process.env);
    const cwd = opts.cwd ?? process.cwd();
    const requestedArgs = opts.args ?? [];

    // Resolve the command against PATH (cross-platform) so we can (a) give an
    // actionable error if it's missing and (b) wrap Windows .cmd/.bat scripts
    // through cmd.exe — running those directly is a common cause of a code-1 exit.
    const spec = buildSpawnSpec(opts.command, requestedArgs, { cwd, env });

    // Basic milestone: the exact command/args/cwd we are about to spawn — the
    // single most useful line when diagnosing a spawn or "exited code 1" failure.
    log.info('spawning pty', {
      requested: opts.command,
      resolved: spec.resolved,
      wrapped: spec.wrapped,
      command: spec.command,
      args: spec.args,
      cwd,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    });
    if (!spec.resolved) {
      log.warn('command did not resolve on PATH — node-pty may fail to launch it', {
        command: opts.command,
        cwd,
        platform: process.platform,
      });
    }
    // Verbose: surface PATH/PATHEXT, which govern whether a bare command name
    // (e.g. `claude`) resolves at all on this platform.
    log.debug('spawn environment', {
      PATH: env['PATH'] ?? env['Path'],
      PATHEXT: env['PATHEXT'],
      ComSpec: env['ComSpec'] ?? env['COMSPEC'],
      platform: process.platform,
    });
    let term: pty.IPty;
    try {
      term = pty.spawn(spec.command, spec.args, {
        name: 'xterm-color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd,
        env,
      });
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err);
      const hint = spec.resolved
        ? `resolved to ${spec.resolved}`
        : `"${opts.command}" was not found on PATH (cwd=${cwd}). Check the "Claude command" setting and your PATH.`;
      log.error('pty spawn threw', { command: spec.command, cwd, resolved: spec.resolved, error: base });
      throw new Error(`Failed to launch ${opts.command}: ${base} — ${hint}`);
    }
    this.term = term;
    log.info('pty spawned', { pid: term.pid });

    term.onData((d) => {
      log.debug('pty data', { bytes: d.length });
      for (const h of this.dataHandlers) h(d);
    });
    term.onExit(({ exitCode, signal }) => {
      this.term = undefined;
      log.info('pty exited', { exitCode, signal });
      for (const h of this.exitHandlers) h({ exitCode, signal });
    });
  }

  write(data: string): void {
    this.term?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.term) return;
    if (cols > 0 && rows > 0) this.term.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.term?.kill(signal);
  }

  /** Subscribe to PTY output. Returns an unsubscribe function. */
  onData(handler: PtyDataHandler): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  /** Subscribe to PTY exit. Returns an unsubscribe function. */
  onExit(handler: PtyExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }
}

/** Drop undefined values so node-pty receives a clean string map. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
