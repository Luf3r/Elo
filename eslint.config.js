import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['docs/**', 'dist/**', '.wrangler/**', 'package-lock.json', '.agent-runs/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importX,
    },
    settings: {
      'import-x/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
        node: true,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-enum-comparison': 'warn',
      // Regras restantes que exigem refatoração ou limpeza em massa viram 'warn' na Fase 1.
      // Métodos async sem await em mocks de teste que implementam interfaces Promise.
      '@typescript-eslint/require-await': 'warn',
      // Type assertions redundantes legadas em src/ e test/, pendentes de limpeza na Fase 3.
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      // Imports/variáveis não usados legados em test/; prefixo _ já ignorado por convenção.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Concatenação de URLSearchParams com '+' em chat client e testes OAuth; exige troca para .toString().
      '@typescript-eslint/restrict-plus-operands': 'warn',
      // Rejeição com signal.reason (any) em src/http.ts e stubs de teste.
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',
      // Referências a métodos em asserções/mocks de teste.
      '@typescript-eslint/unbound-method': 'warn',
      // String(input) sobre RequestInfo | URL em helper de teste OAuth.
      '@typescript-eslint/no-base-to-string': 'warn',
      // Regras de fronteira entre camadas da seção 2 do plano (aviso até a Fase 3.9).
      'import-x/no-restricted-paths': [
        'warn',
        {
          zones: [
            {
              target: './src/agendor',
              from: './src/automation',
              message: 'Camada agendor não deve importar automation (use ports injetáveis; Fase 3.1).',
            },
            {
              target: './src/agendor',
              from: './src/domain',
              message: 'Camada agendor não deve importar domain.',
            },
            {
              target: './src/domain',
              from: './src/agendor',
              message: 'Camada domain deve ser pura e não importar adaptadores agendor.',
            },
            {
              target: './src/domain',
              from: './src/automation',
              message: 'Camada domain deve ser pura e não importar automation/IO.',
            },
            {
              target: './src/domain',
              from: './src/mcp',
              message: 'Camada domain deve ser pura e não importar mcp.',
            },
            {
              target: './src/domain',
              from: './src/oauth',
              message: 'Camada domain deve ser pura e não importar oauth.',
            },
            {
              target: './src/domain',
              from: './src/app',
              message: 'Camada domain deve ser pura e não importar app/env.',
            },
            {
              target: './src/mcp',
              from: './src/automation/state',
              message: 'Camada mcp deve falar apenas com usecases, não com automation/state.',
            },
            {
              target: './src/mcp',
              from: './src/automation/execution',
              message: 'Camada mcp deve falar apenas com usecases, não com automation/execution.',
            },
            {
              target: './src/mcp',
              from: './src/oauth',
              message: 'Camada mcp não deve importar oauth.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
  {
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      '@stylistic/max-statements-per-line': ['error', { max: 1 }],
      'max-lines': ['warn', { max: 400 }],
      // Escapes redundantes legados em regexes e template strings; limpeza sem mudar comportamento fica para refatoração.
      'no-useless-escape': 'warn',
      // Bloco catch vazio intencional ao extrair código JSON de erro em scripts/verify-automation-mcp.mjs.
      'no-empty': 'warn',
      // scripts/verify-chat-contract.mjs omite `cause` intencionalmente para não vazar detalhes de transporte/headers.
      'preserve-caught-error': 'warn',
    },
  },
);
