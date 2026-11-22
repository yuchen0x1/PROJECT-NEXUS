# PHASE 6 Workspace — Isolation, Diff, Rollback, Apply

Date: 2026-11-13 · Module: `server/services/agent/workspace-worktree.mjs` + `server/services/local-agent-workspace.mjs`

## 1. Two adapters, one interface

| | Worktree adapter (git projects) | Copy adapter (everything else) |
| --- | --- | --- |
| Creation | `git worktree add -b nexus-agent/<taskId> <managed dir> HEAD` | bounded snapshot copy with baseline manifest |
| Change detection | `git status --porcelain` + `git diff --cached HEAD` | baseline sha256 comparison with before/after content |
| Rollback | `git reset` + `git checkout HEAD -- .` + `git clean -qfd` | rewrite baseline files + remove non-baseline files |
| File restore | `git checkout HEAD -- <path>` / delete if newly added | copy back from `baseline-files/` or delete |
| Dispose | `git worktree remove --force` + `git branch -D` | recursive delete of the task workspace |
| Shared surface | readFiles, readAllFiles, applyOperations(create/replace), deleteFile, listChanges, diff, restoreFile, restoreAll, dispose | same |

`createAgentWorkspace({mode: 'auto'})` prefers a worktree and falls back to
the copy adapter with a recorded `fallbackReason` (no git, no commits, git
unavailable). The task record stores the chosen mode for the UI.

## 2. Guarantees

1. **The original project is never written during a run.** Every mutation
   happens inside `agent-workspaces/agent/…`; tests assert byte-identical
   hashes on the original tree (unit + acceptance evidence).
2. **Per-task isolation.** One workspace per task id; duplicate worktree task
   ids are rejected (`AGENT_WORKSPACE_EXISTS`).
3. **Bounded content.** The copy adapter keeps the PHASE 4 ceilings (4,000
   files / 256 MB / depth 16 / symlink refusal / gitignore policy). The
   worktree adapter bounds reads and diff output instead of copying.
4. **Uncommitted user work is untouchable.** Worktrees are created from HEAD;
   the user's dirty working tree stays theirs. Apply refuses outright if the
   original tree has any uncommitted change (`AGENT_APPLY_DIRTY_PROJECT`).

## 3. Diff content pipeline

The task-detail endpoint serves per-file before/after content: copy mode from
the baseline manifest; worktree mode via `git show HEAD:<path>` for "before"
and the workspace file for "after", each capped at 200 KB, with
`contentStatus: preview-unavailable` for oversized or vanished files.

## 4. Rollback and apply semantics

- `POST /api/local-agent/tasks/:id/rollback` restores the workspace to its
  start state (mode-aware) and records a `rolled_back` event. It never
  touches the original project (there is nothing to touch — the project was
  never modified).
- `POST /api/local-agent/tasks/:id/apply {confirm:true}`:
  1. refuses while the task is queued/running,
  2. refuses a dirty original tree,
  3. backs up every overwritten/deleted original under
     `agent-workspaces/agent/apply-backup/<taskId>/` (COPYFILE_EXCL, so a
     re-apply never clobbers the first backup),
  4. writes/deletes files exactly as the workspace holds them,
  5. records `applied_to_project` with the path list.
  Apply does not stage, commit, push or publish anything.

## 5. Crash recovery

On service start, `recoverLocalAgentTaskStore` flips `Running` tasks to
`Interrupted` with an explanatory event. Workspaces are deliberately left in
place; the task detail endpoint revalidates the workspace lazily
(`AGENT_WORKSPACE_GONE` when physically missing), and the user chooses to
re-run, roll back, or apply. The desktop never renders an exited backend
process as running: status comes from the persisted store, not from process
liveness.
