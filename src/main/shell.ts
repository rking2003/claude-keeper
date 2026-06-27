/** Resolve a sensible default interactive shell per OS. */
export function resolveDefaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    return env['ComSpec'] || 'cmd.exe';
  }
  return env['SHELL'] || '/bin/bash';
}
