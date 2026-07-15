/**
 * ESLint v10 flat config — replaces the deprecated .eslintrc.cjs format.
 *
 * Five config objects handle the project's different environments:
 *   1. Server / scripts  (Node.js CJS)
 *   2. Tests              (Node.js + Jest, CommonJS)
 *   3. ESM test setup     (ESM import/export)
 *   4. Frontend           (Browser + CDN globals, CommonJS-style)
 *   5. ESM frontend       (ESM import/export)
 *
 * Plugins: eslint-plugin-security for all source file groups.
 */

const globals = require('globals');
const securityPlugin = require('eslint-plugin-security');

const sharedPlugins = {
  security: securityPlugin
};

const securityRules = {
  'security/detect-eval-with-expression':              'warn',
  'security/detect-non-literal-fs-filename':            'warn',
  'security/detect-possible-timing-attacks':            'warn',
  'security/detect-pseudoRandomBytes':                  'warn',
  'security/detect-unsafe-regex':                       'warn',
  'security/detect-buffer-noassert':                    'warn',
  'security/detect-child-process':                      'warn',
  'security/detect-disable-mustache-escape':            'warn',
  'security/detect-new-buffer':                         'warn',
  'security/detect-no-csrf-before-method-override':     'warn',
  'security/detect-non-literal-regexp':                 'warn',
  'security/detect-object-injection':                   'off' /* too noisy for dynamic JS patterns */
};

/** Shared base rules applied to every file group. */
const sharedRules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  'no-console': 'off',
  ...securityRules
};

module.exports = [
  /* ── Global ignores ──────────────────────────────────────────────────── */
  {
    ignores: [
      'node_modules/', 'coverage/', 'Solar/',
      /* dashboard.js / analytics.js are compiled from the .jsx sources by
         compileJsx() on every boot — they're build artifacts, not source,
         so linting them just flags noise in generated code. */
      'public/admin/dashboard.js', 'public/admin/analytics.js'
    ]
  },

  /* ── Server-side Node.js files ─────────────────────────────────────────
       server.js, db.js, authMiddleware.js, relay.js, mailer.js, ai-models.js
       and anything inside scripts/. */
  {
    files: ['**/*.js', '**/*.cjs'],
    ignores: ['public/**', '__tests__/**'],
    plugins: sharedPlugins,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.node, ...globals.es2022 }
    },
    rules: sharedRules
  },

  /* ── Test files (Node.js + Jest globals, CommonJS) ─────────────────────
       __tests__/setup.js uses ESM and is handled separately below. */
  {
    files: ['__tests__/**/*.js'],
    ignores: ['__tests__/setup.js'],
    plugins: sharedPlugins,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.node, ...globals.es2022, ...globals.jest }
    },
    rules: sharedRules
  },

  /* ── ESM test setup (import { jest } from '@jest/globals') ──────────── */
  {
    files: ['__tests__/setup.js'],
    plugins: sharedPlugins,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022, ...globals.jest }
    },
    rules: sharedRules
  },

  /* ── Frontend files (browser + CDN-loaded globals) ─────────────────────
       React, ReactDOM, Chart.js, react-chartjs-2 are loaded via <script>
       tags in the HTML, not bundled; ESLint needs them declared manually.
       Most use globals-style code (sourceType: 'script').
       public/admin/index.js and ai-models.js use ESM and are handled next. */
  {
    files: ['public/**/*.js'],
    ignores: ['public/admin/index.js', 'public/admin/ai-models.js'],
    plugins: sharedPlugins,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.es2022,
        React:        'readonly',
        ReactDOM:     'readonly',
        Chart:        'readonly',
        ReactChartjs2: 'readonly'
      }
    },
    rules: sharedRules
  },

  /* ── ESM frontend scripts (import/export syntax) ───────────────────────
       public/admin/index.js and ai-models.js use ESM import/export to
       reference each other. Plain JS logic files (not React components). */
  {
    files: ['public/admin/index.js', 'public/admin/ai-models.js'],
    plugins: sharedPlugins,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2022 }
    },
    rules: sharedRules
  }
];
