import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const strictTypeRules = {
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
  '@typescript-eslint/no-unsafe-enum-comparison': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/restrict-plus-operands': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/unbound-method': 'error',
  '@typescript-eslint/no-base-to-string': 'error',
  'no-useless-escape': 'error',
  'no-empty': 'error',
  'preserve-caught-error': 'error',
};

export default tseslint.config(
  {
    ignores: [
      'docs/**',
      'dist/**',
      '.wrangler/**',
      'package-lock.json',
      '.agent-runs/**',
      '.tooling/**',
      '.superpowers/**',
    ],
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
      // A regra só acusa funções async sem await, que aqui implementam interfaces que devolvem Promise; tirar o async trocaria rejeição por exceção síncrona, e promessas esquecidas já são pegas por no-floating-promises e no-misused-promises.
      '@typescript-eslint/require-await': 'off',
      // Regras de fronteira entre camadas da seção 2 do plano (erro na Fase 3.9).
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/shared',
              from: './src/automation',
              message: 'Camada shared não deve importar automation.',
            },
            {
              target: './src/shared',
              from: './src/domain',
              message: 'Camada shared não deve importar domain.',
            },
            {
              target: './src/shared',
              from: './src/agendor',
              message: 'Camada shared não deve importar adaptadores agendor.',
            },
            {
              target: './src/shared',
              from: './src/mcp',
              message: 'Camada shared não deve importar mcp.',
            },
            {
              target: './src/shared',
              from: './src/oauth',
              message: 'Camada shared não deve importar oauth.',
            },
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
              except: ['./config/tenant.ts'],
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
  {
    files: ['src/agendor/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(?:^|/)automation(?:/|$)',
              message: 'Camada agendor não deve importar src/automation (use src/agendor/ports.ts).',
            },
            {
              regex: '(?:^|/)domain(?:/|$)',
              message: 'Camada agendor não deve importar src/domain.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(?:^|/)automation/state(?:/|$)',
              message: 'Camada domain não deve importar src/automation/state.',
            },
            {
              regex: '(?:^|/)agendor/[^/]+/client(?:/|$)',
              message: 'Camada domain não deve importar src/agendor/*/client.',
            },
            {
              regex: '(?:^|/)env$',
              message: 'Camada domain não deve importar o tipo Env.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'TSAsExpression[expression.callee.object.name="JSON"][expression.callee.property.name="parse"], TSTypeAssertion[expression.callee.object.name="JSON"][expression.callee.property.name="parse"]',
          message: 'Use readJson(schema, text) from src/shared/json.ts instead of JSON.parse(...) as T.',
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
      'max-lines': ['error', { max: 400 }],
    },
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    rules: strictTypeRules,
  },
  {
    files: ['test/**/*.ts'],
    rules: strictTypeRules,
  },
  {
    files: ['test/**'],
    rules: {
      // Arquivos de teste longos são aceitos; o limite de 400 linhas vale como erro em todo o restante.
      'max-lines': 'off',
    },
  },
  {
    files: ['src/automation/state/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(?:^|/)identity(?:/|$)',
              message: 'Camada automation/state não deve importar domain/identity.',
            },
            {
              regex: '(?:^|/)demands(?:/|$)',
              message: 'Camada automation/state não deve importar domain/demands.',
            },
            {
              regex: '(?:^|/)context/render(?:/|$)',
              message: 'Camada automation/state não deve importar context/render.',
            },
          ],
        },
      ],
    },
  },
);
