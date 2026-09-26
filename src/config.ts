import * as vscode from 'vscode';
import type { ConnectionSettings } from './cliArgs';
import { DEFAULT_DOCS_BASE } from './cliOutput';

export type ValidationMode = 'auto' | 'preflight' | 'local' | 'off';

export const SECRET_API_KEY = 'orch8.apiKey';

export interface Orch8Config extends ConnectionSettings {
  cliPath: string;
  validationMode: ValidationMode;
  validateOnSave: boolean;
  validateOnOpen: boolean;
  validateYaml: boolean;
  timeoutMs: number;
  docsBaseUrl: string;
  codeLens: boolean;
  devExtraArgs: string[];
}

export function readConfig(scope?: vscode.ConfigurationScope): Orch8Config {
  const c = vscode.workspace.getConfiguration('orch8', scope);
  return {
    cliPath: c.get<string>('cliPath', 'orch8').trim() || 'orch8',
    serverUrl: c.get<string>('serverUrl', ''),
    tenantId: c.get<string>('tenantId', ''),
    validationMode: c.get<ValidationMode>('validation.mode', 'auto'),
    validateOnSave: c.get<boolean>('validation.onSave', true),
    validateOnOpen: c.get<boolean>('validation.onOpen', false),
    validateYaml: c.get<boolean>('validation.yaml', true),
    timeoutMs: Math.max(1000, c.get<number>('validation.timeoutMs', 20000)),
    docsBaseUrl: c.get<string>('docsBaseUrl', DEFAULT_DOCS_BASE) || DEFAULT_DOCS_BASE,
    codeLens: c.get<boolean>('codeLens.enabled', true),
    devExtraArgs: c.get<string[]>('dev.extraArgs', []).filter((a) => typeof a === 'string'),
  };
}

/** Environment for CLI child processes / terminals. The API key never goes on the command line. */
export async function cliEnv(secrets: vscode.SecretStorage): Promise<Record<string, string>> {
  const key = await secrets.get(SECRET_API_KEY);
  return key ? { ORCH8_API_KEY: key } : {};
}
