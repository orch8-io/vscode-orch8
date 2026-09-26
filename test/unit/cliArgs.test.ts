import { describe, expect, it } from 'vitest';
import {
  applyArgs,
  commandLine,
  contractTestArgs,
  devArgs,
  globalArgs,
  normalizeDraft,
  preflightJsonArgs,
  quoteArg,
  shellFlavorFor,
  smokeTestArgs,
  strictCheckArgs,
} from '../../src/cliArgs';

describe('CLI argument builders', () => {
  it('only passes connection flags that are set', () => {
    expect(globalArgs({})).toEqual([]);
    expect(globalArgs({ serverUrl: ' http://h:8080/api/v1 ', tenantId: 'acme' })).toEqual(['--url', 'http://h:8080/api/v1', '--tenant-id', 'acme']);
  });

  it('builds the real subcommands', () => {
    expect(preflightJsonArgs('/t/d.json', { tenantId: 't' })).toEqual(['--tenant-id', 't', '--output', 'json', 'sequence', 'preflight', '--file', '/t/d.json']);
    expect(strictCheckArgs('/t/d.json')).toEqual(['sequence', 'upgrade-format', '/t/d.json']);
    expect(devArgs('/w/a.orch8.json', ['--skip-timers'])).toEqual(['dev', '/w/a.orch8.json', '--skip-timers']);
    expect(smokeTestArgs('/w/a.json')).toEqual(['dev', '/w/a.json', '--once', '--dry-run', '--skip-timers', '--no-server']);
    expect(contractTestArgs('/w/a.contracts.json', '/w/a.json')).toEqual(['test', 'run', '/w/a.contracts.json', '--sequence', '/w/a.json']);
    expect(applyArgs('/w/a.json', true, {})).toEqual(['sequence', 'apply', '/w/a.json', '--dry-run']);
    expect(applyArgs('/w/a.json', false, { serverUrl: 'u' })).toEqual(['--url', 'u', 'sequence', 'apply', '/w/a.json']);
  });

  it('never puts an API key on the command line', () => {
    const all = [preflightJsonArgs('f', { serverUrl: 'u', tenantId: 't' }), applyArgs('f', false, { serverUrl: 'u' })].flat();
    expect(all).not.toContain('--api-key');
  });
});

describe('shell quoting', () => {
  it('leaves safe args bare and quotes the rest', () => {
    expect(quoteArg('/a/b-c_d.json')).toBe('/a/b-c_d.json');
    expect(quoteArg('/my dir/it\'s.json')).toBe(`'/my dir/it'\\''s.json'`);
    expect(quoteArg('', 'posix')).toBe(`''`);
    expect(quoteArg('a b', 'powershell')).toBe(`'a b'`);
    expect(quoteArg("it's", 'powershell')).toBe(`'it''s'`);
    expect(quoteArg('a "b"', 'cmd')).toBe(`"a ""b"""`);
  });

  it('builds command lines per shell', () => {
    expect(commandLine('orch8', ['dev', '/x y/a.json'])).toBe(`orch8 dev '/x y/a.json'`);
    expect(commandLine('C:\\Program Files\\orch8.exe', ['dev'], 'powershell')).toBe(`& 'C:\\Program Files\\orch8.exe' dev`);
  });

  it('detects the shell flavor', () => {
    expect(shellFlavorFor('/bin/zsh', 'darwin')).toBe('posix');
    expect(shellFlavorFor('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32')).toBe('powershell');
    expect(shellFlavorFor('C:\\Windows\\System32\\cmd.exe', 'win32')).toBe('cmd');
    expect(shellFlavorFor(undefined, 'win32')).toBe('powershell');
  });
});

describe('normalizeDraft', () => {
  const opts = { newId: () => 'uuid-1', now: () => new Date('2026-01-02T03:04:05Z') };

  it('fills server-assigned fields', () => {
    expect(normalizeDraft({ name: 'x', blocks: [] }, opts)).toEqual({
      name: 'x',
      blocks: [],
      id: 'uuid-1',
      tenant_id: 'default',
      namespace: 'default',
      version: 1,
      created_at: '2026-01-02T03:04:05.000Z',
    });
  });

  it('keeps existing values and honours the configured tenant', () => {
    const out = normalizeDraft({ id: 'keep', namespace: 'ns', version: 7 }, { ...opts, tenantId: 'acme' });
    expect(out).toMatchObject({ id: 'keep', namespace: 'ns', version: 7, tenant_id: 'acme' });
  });
});
