# PHASE 6 Project Understanding — Index and Context Selection

Date: 2026-11-13 · Modules: `server/services/agent/indexer.mjs`, `context.mjs`

## 1. Indexer

`scanProjectStructure(root)` walks the workspace with hard ceilings (8,000
files, depth 14, 1 MB per file, 60k tree entries, binary extensions skipped,
dependency/build/cache directories excluded) and produces:

- **file inventory** — path, size, mtime, extension, language
  (JS/TS/JSX/TSX/Python/Go/Rust classification)
- **symbols** — functions, classes, exported components, Python def/class,
  Go func/type, Rust fn/struct/enum/trait with line numbers (fast,
  language-tuned regex extraction; approximate by design, compiler-grade
  analysis is a future tree-sitter backend)
- **imports** — JS import/require/export-from and Python import/from edges
- **manifests** — package.json (scripts/dependencies/devDependencies), 
  pyproject.toml and friends, parsed and bounded
- **structural intelligence** — entry points (manifest `main` + conventions
  + fallback), test files, route candidates, API-handler candidates

`buildProjectIndex({root, cacheFile})` persists the index to
`agent-indexes/<projectId>.json` and re-indexes **incrementally**: unchanged
(mtime+size) files are reused from cache; only changed files are re-read for
symbols/imports. The acceptance run evidences this (`3 re-indexed` on first
scan, `0` on no-op rebuilds).

## 2. Context selection

`selectTaskContext({index, prompt, budgetBytes=120KB, maxFiles=24})` ranks:

1. manifest/config files (priority 0),
2. files whose path or basename matches prompt keywords (tokenized,
   length-weighted scoring),
3. files whose extracted symbols match the prompt,
4. import neighbors (both directions) of the matched set,
5. entry points and a slice of test files.

Selection stops at the byte budget; each file is capped by a read window
(16 KB head + 6 KB tail for oversized files) and passes through
`redactSecrets` before ever leaving the service. The disclosed path list is
persisted on the task so the UI can show exactly what left the machine.

## 3. REST surface

`POST /api/local-agent/projects/:projectId/insights` builds (or refreshes) the
index for a registered project and returns stats, languages, manifests with
scripts, entry points, tests and route/API candidates — this powers the
"Analyze project" panel in the desktop UI.

## 4. Limits and honesty

The indexer never reads: .git, node_modules, dist/build outputs, virtualenvs,
binary blobs, secret-like files. If a project exceeds limits the index is
marked `truncated` and the agent still functions via its read/list/search
tools. Findings are evidence-ranked, not hand-waved: the UI shows per-file
reasons ("matches task keywords", "imported by …", "entry point").
