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
    ignores: ['docs/**', 'dist/**', '.wrangler/**', 'package-lock.json', '.agent-runs/**', '.tooling/**', '.superpowers/**'],
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
      // A regra só acusa funções async sem await, que aqui implementam interfaces que devolvem Promise; tirar o async trocaria rejeição por exceção síncrona, e promessas esquecidas já são pegas por no-floating-promises e no-misused-promises.
      '@typescript-eslint/require-await': 'off',
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
      // Regras de fronteira entre camadas da seção 2 do plano (erro na Fase 3.9).
      'import-x/no-restricted-paths': [
        'error',
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
    files: ['src/app/config/tenant.ts'],
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
  {
    files: ['src/**/*.ts'],
    ignores: ['src/app/config/tenant.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=4101], Literal[value="4101"], Literal[value=4102], Literal[value="4102"], TemplateElement[value.raw=/^(?:4101|4102)$/]',
          message: 'Use ALLOWED_INBOX_IDS from src/app/config/tenant.ts instead of hardcoding inbox IDs.',
        },
        {
          selector: 'Literal[value=7001], Literal[value="7001"], TemplateElement[value.raw="7001"]',
          message: 'Use EXPECTED_CHAT_ACCOUNT_ID from src/app/config/tenant.ts instead of hardcoding the Chat account ID.',
        },
        {
          selector: 'Literal[value="elo-agendor-mcp"], TemplateElement[value.raw="elo-agendor-mcp"]',
          message: 'Use TENANT_SERVICE_NAME from src/app/config/tenant.ts instead of hardcoding the service name.',
        },
        {
          selector:
            'TSAsExpression[expression.callee.object.name="JSON"][expression.callee.property.name="parse"], TSTypeAssertion[expression.callee.object.name="JSON"][expression.callee.property.name="parse"]',
          message: 'Use readJson(schema, text) from src/shared/json.ts instead of JSON.parse(...) as T.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    // domain/schemas/{analysis,planning}.ts, domain/planner.ts and domain/stages.ts use 'elotenant' as a domain actor/approach enum literal, not the tenant account key.
    ignores: [
      'src/app/config/tenant.ts',
      'src/domain/schemas/analysis.ts',
      'src/domain/schemas/planning.ts',
      'src/domain/planner.ts',
      'src/domain/planner-demand.ts',
      'src/domain/stages.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=4101], Literal[value="4101"], Literal[value=4102], Literal[value="4102"], TemplateElement[value.raw=/^(?:4101|4102)$/]',
          message: 'Use ALLOWED_INBOX_IDS from src/app/config/tenant.ts instead of hardcoding inbox IDs.',
        },
        {
          selector: 'Literal[value=7001], Literal[value="7001"], TemplateElement[value.raw="7001"]',
          message: 'Use EXPECTED_CHAT_ACCOUNT_ID from src/app/config/tenant.ts instead of hardcoding the Chat account ID.',
        },
        {
          selector: 'Literal[value="elo-agendor-mcp"], TemplateElement[value.raw="elo-agendor-mcp"]',
          message: 'Use TENANT_SERVICE_NAME from src/app/config/tenant.ts instead of hardcoding the service name.',
        },
        {
          selector: 'Literal[value="elotenant"], TemplateElement[value.raw="elotenant"]',
          message: 'Use TENANT_ACCOUNT_KEY from src/app/config/tenant.ts instead of hardcoding "elotenant".',
        },
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
      'max-lines': ['warn', { max: 400 }],
      // Escapes redundantes legados em regexes e template strings; limpeza sem mudar comportamento fica para refatoração.
      'no-useless-escape': 'warn',
      // Bloco catch vazio legado; mantido em aviso para compatibilidade.
      'no-empty': 'warn',
      // Omissão intencional de `cause` em erros sanitizados (ex.: scripts/verify-chat-contract.ts) para não vazar transporte/headers.
      'preserve-caught-error': 'warn',
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
      // Arquivos de teste longos são aceitos; o limite de 400 linhas continua como erro em src/.
      'max-lines': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 400 }],
    },
  },
  {
    files: ['src/automation/state/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 400 }],
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
