import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Evidence snapshots and isolated worktrees may contain historical tests.
  // Discover only this application's maintained test suite.
  test: { include: ['tests/unit/**/*.test.mjs'] }
})
