/**
 * Argument builders for the orch8 CLI. Pure — no `vscode` import.
 *
 * Every subcommand and flag used here exists in engine/orch8-cli (clap):
 *   global:  --url <URL>, --tenant-id <ID>, -o/--output json   (main.rs `Cli`)
 *            --api-key is deliberately never passed: the key goes through
 *            the ORCH8_API_KEY env var so it never lands in shell history.
 *   sequence preflight --file <FILE>                           (commands/sequence.rs)
 *   sequence upgrade-format <FILE>                             (commands/sequence.rs)
 *   sequence apply <PATH> [--dry-run]                          (commands/sequence.rs)
 *   dev [PATH] [--once] [--dry-run] [--skip-timers] [--no-server]  (commands/dev.rs)
 *   test run <CONTRACT_FILE> [--sequence <FILE>]               (commands/test_cmd.rs)
 */

export interface ConnectionSettings {
  serverUrl?: string;
  tenantId?: string;
}

export function globalArgs(s: ConnectionSettings): string[] {
  const out: string[] = [];
  if (s.serverUrl?.trim()) out.push('--url', s.serverUrl.trim());
  if (s.tenantId?.trim()) out.push('--tenant-id', s.tenantId.trim());
  return out;
}

export function preflightJsonArgs(draftFile: string, s: ConnectionSettings): string[] {
  return [...globalArgs(s), '--output', 'json', 'sequence', 'preflight', '--file', draftFile];
}

/** Offline strict decode + validate; prints the upgraded document to stdout (discarded). */
export function strictCheckArgs(draftFile: string): string[] {
  return ['sequence', 'upgrade-format', draftFile];
}

export function preflightTerminalArgs(file: string, s: ConnectionSettings): string[] {
  return [...globalArgs(s), 'sequence', 'preflight', '--file', file];
}

export function devArgs(file: string, extra: readonly string[] = []): string[] {
  return ['dev', file, ...extra];
}

/** No contracts file: run once, offline, with stubbed side effects and virtual time. */
export function smokeTestArgs(file: string): string[] {
  return ['dev', file, '--once', '--dry-run', '--skip-timers', '--no-server'];
}

export function contractTestArgs(contractsFile: string, sequenceFile: string): string[] {
  return ['test', 'run', contractsFile, '--sequence', sequenceFile];
}

export function applyArgs(file: string, dryRun: boolean, s: ConnectionSettings): string[] {
  return [...globalArgs(s), 'sequence', 'apply', file, ...(dryRun ? ['--dry-run'] : [])];
}

// ---------------------------------------------------------------------------
// Shell quoting for integrated-terminal commands
// ---------------------------------------------------------------------------

export type ShellFlavor = 'posix' | 'powershell' | 'cmd';

export function quoteArg(arg: string, flavor: ShellFlavor = 'posix'): string {
  if (arg !== '' && /^[\w@%+=:,./-]+$/.test(arg)) return arg;
  switch (flavor) {
    case 'posix':
      return `'${arg.replace(/'/g, `'\\''`)}'`;
    case 'powershell':
      return `'${arg.replace(/'/g, "''")}'`;
    case 'cmd':
      return `"${arg.replace(/"/g, '""')}"`;
  }
}

export function commandLine(cli: string, args: readonly string[], flavor: ShellFlavor = 'posix'): string {
  const exe = quoteArg(cli, flavor);
  // PowerShell needs the call operator to run a quoted executable path.
  const prefix = flavor === 'powershell' && exe.startsWith("'") ? `& ${exe}` : exe;
  return [prefix, ...args.map((a) => quoteArg(a, flavor))].join(' ');
}

export function shellFlavorFor(shellPath: string | undefined, platform: string): ShellFlavor {
  const s = (shellPath ?? '').toLowerCase();
  if (s.includes('pwsh') || s.includes('powershell')) return 'powershell';
  if (s.endsWith('cmd.exe') || s === 'cmd') return 'cmd';
  if (!s && platform === 'win32') return 'powershell';
  return 'posix';
}

// ---------------------------------------------------------------------------
// Draft normalization (what `orch8 dev` / `generate` do before decoding)
// ---------------------------------------------------------------------------

/**
 * Fill server-assigned root fields that authoring drafts omit, so the
 * server-side decode used by `sequence preflight` accepts the draft. Only
 * adds root members; existing values are kept, so pointers into the
 * original document stay valid.
 */
export function normalizeDraft(
  value: Record<string, unknown>,
  opts: { tenantId?: string; newId: () => string; now: () => Date },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  out.id ??= opts.newId();
  out.tenant_id ??= opts.tenantId?.trim() || 'default';
  out.namespace ??= 'default';
  out.version ??= 1;
  out.created_at ??= opts.now().toISOString();
  return out;
}
