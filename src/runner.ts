import { execFile } from 'node:child_process';

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failure (e.g. ENOENT) or timeout. */
  error?: NodeJS.ErrnoException & { killed?: boolean };
}

/** Run the CLI without a shell. Never rejects. */
export function runCli(
  cli: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      cli,
      [...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, NO_COLOR: '1', ...opts.env },
        timeout: opts.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        signal: opts.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        const spawnFailed = !!error && (typeof error.code === 'string' || (error as { killed?: boolean }).killed);
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
          error: spawnFailed ? (error as CliResult['error']) : undefined,
        });
      },
    );
  });
}
