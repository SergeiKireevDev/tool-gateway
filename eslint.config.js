// @ts-check
import eslint from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'data/', 'coverage/', 'node_modules/', 'web/.next/', 'web/next-env.d.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'web/postcss.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    files: ['src/server/**/*.ts', 'test/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Rules carried over from ../../oyster/eslint.config.mjs (applied to application code, like
    // oyster, not to tests). TypeScript-aware variants replace the core rules where one exists.
    files: ['src/server/**/*.ts', 'web/**/*.{ts,tsx}'],
    plugins: { sonarjs },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-magic-numbers': 'off',
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2],
          ignoreDefaultValues: true,
          enforceConst: true,
          // TypeScript-only constructs the JS rule never sees
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
      'sonarjs/no-collapsible-if': 'error',
      'sonarjs/no-duplicate-string': ['error', { threshold: 3 }],
      'sonarjs/no-duplicated-branches': 'error',
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-nested-template-literals': 'error',
      'sonarjs/no-redundant-optional': 'error',
      'sonarjs/cognitive-complexity': ['error', 25],
      'sonarjs/cyclomatic-complexity': ['error', { threshold: 15 }],
      'sonarjs/nested-control-flow': ['error', { maximumNestingLevel: 4 }],
    },
  },
  {
    // supertest types response bodies as `any`
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: 'web/' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  { files: ['web/**/*.tsx'], ...reactHooks.configs.flat['recommended-latest'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
