import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { WaitStateStore, type WaitStateIO } from '../core/wait-state';

/** A valid snapshot is a few hundred bytes; anything this large is corrupt/hostile. */
const MAX_WAIT_FILE_BYTES = 256 * 1024;

/**
 * Construct a {@link WaitStateStore} backed by a JSON file holding the single
 * pending-wait snapshot. Directory resolution mirrors the settings store
 * (`app.getPath('userData')`, overridable via `CLAUDE_KEEPER_DATA_DIR`) so the
 * app stays machine-agnostic with no hardcoded paths.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't leave a
 * half-written wait that would later be mis-parsed. `remove()` is best-effort.
 */
export function createFileWaitStore(defaultDir: string): WaitStateStore {
  const dir = process.env['CLAUDE_KEEPER_DATA_DIR'] || defaultDir;
  const file = join(dir, 'pending-wait.json');

  const io: WaitStateIO = {
    read(): string | null {
      if (!existsSync(file)) return null;
      // Guard against an oversized snapshot causing slow launch / memory pressure
      // before the in-parser field caps ever apply.
      if (statSync(file).size > MAX_WAIT_FILE_BYTES) return null;
      return readFileSync(file, 'utf8');
    },
    write(contents: string): void {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(tmp, contents, 'utf8');
        renameSync(tmp, file);
      } catch (err) {
        try {
          if (existsSync(tmp)) rmSync(tmp, { force: true });
        } catch {
          /* best-effort cleanup */
        }
        throw err;
      }
    },
    remove(): void {
      if (existsSync(file)) rmSync(file, { force: true });
    },
  };

  return new WaitStateStore(io);
}
