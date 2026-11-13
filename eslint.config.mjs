import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// Correctness gates for the existing codebase. TypeScript remains the type checker.
// Formatting and broad component rewrites are intentionally outside this migration.
export default [
  { ignores: ['node_modules/**', 'release*/**', 'dist/**', 'docs/**', 'test-results/**', 'NVIDIA Corporation/**'] },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js', '**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-async-promise-executor': 'error', 'no-dupe-args': 'error', 'no-dupe-keys': 'error',
      'no-unreachable': 'error', 'no-unsafe-finally': 'error', 'valid-typeof': 'error',
      'no-constant-binary-expression': 'error'
    }
  }
]
