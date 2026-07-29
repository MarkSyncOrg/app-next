import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '.wxt/',
      '.output/',
      'coverage/',
      'test-results/',
      'playwright-report/',
      'src/types/api.d.ts',
      // MongoDB shell init script (runs in the mongo shell, not our runtime).
      'contract/mongoconfig.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      // Allow intentional `_`-prefixed and rest-sibling omissions (e.g. `{ id, ...rest }`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  // Keep ESLint out of formatting decisions; Prettier owns those.
  eslintConfigPrettier,
);
