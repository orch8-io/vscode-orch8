import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-properties': [
        'error',
        { object: 'child_process', property: 'exec', message: 'Use execFile (no shell).' },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'esbuild.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', structuredClone: 'readonly' } },
  },
);
