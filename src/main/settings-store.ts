import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { SettingsStore, type SettingsIO } from '../core/settings';

/**
 * Construct a {@link SettingsStore} backed by a JSON file. The directory is
 * resolved per-OS/per-user by the caller (main passes `app.getPath('userData')`),
 * but can be overridden via the `CLAUDE_KEEPER_DATA_DIR` env var for tests and
 * sandboxed runs — keeping the app machine-agnostic with no hardcoded paths.
 *
 * Writes go to a unique temp file and are renamed into place, so a crash
 * mid-write cannot replace a good settings file with a truncated one. (This is
 * not full power-loss durability — we do not fsync — which is acceptable for
 * desktop preferences.) The temp file is cleaned up if the rename fails.
 */
export function createFileSettingsStore(defaultDir: string): SettingsStore {
  const dir = process.env['CLAUDE_KEEPER_DATA_DIR'] || defaultDir;
  const file = join(dir, 'settings.json');

  const io: SettingsIO = {
    read(): string | null {
      if (!existsSync(file)) return null;
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
  };

  return new SettingsStore(io);
}
