import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Evidence snapshots and isolated worktrees may contain historical tests.
  // Discover only this application's maintained test suite.
  test: {
    include: ['tests/unit/**/*.test.{mjs,ts}'],
    // Each agent-workspace Git command starts a bounded PowerShell job. A high
    // worker count contends for job slots on developer machines, producing
    // spurious "git clean failed (1073807364)" and 5s timeout failures even
    // though every test passes serially and in GitHub Actions. Keep the local
    // and CI contract identical and deterministic.
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
