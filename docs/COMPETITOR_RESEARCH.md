# Competitor research

Research was completed before implementation using official repositories and documentation where available. The goal was to extract interaction patterns and operational boundaries, not copy source code.

| Area | Projects reviewed | Ideas carried into NEXUS |
|---|---|---|
| Git hosting and repo operations | GitHub CLI, GitHub Desktop, gh-dash, Gitea, Forgejo, GitLab | explicit repository context, compact operational lists, scoped actions |
| CI/CD | Dagger, Woodpecker CI, Jenkins, Argo CD, GitHub Actions | workflow/run separation, dispatch controls, durable task status, failure isolation |
| Releases and updates | electron-builder, electron-updater, Tauri Updater, Velopack, Changesets, semantic-release | release/readiness boundaries, update configuration as a separate concern, approval before publishing |
| Monitoring | Grafana, Uptime Kuma, Netdata, GlitchTip, Sentry | signal-first health views, severity-aware status, no synthetic uptime claims |
| AI engineering | OpenHands, Continue, Aider, SWE-agent, Codex-style tool workflows | evidence-backed diagnosis, tool-mediated operations, human approval for code changes |
| Deployment | Vercel, Cloudflare Pages, Netlify, GitHub Pages, Docker | provider adapters, deployment history as a task, health confirmation after deploy |

## Direct product consequences

1. The Overview page stays useful with no data: it explains the missing connection instead of filling cards with invented numbers.
2. Build Center separates repository selection, workflow catalog, and run history so a failed run can be traced to a real GitHub URL.
3. Tasks have independent states. A future batch build can fail one child task without cancelling siblings.
4. AI Operations describes capabilities and provider prerequisites but does not claim a diagnosis without a configured model and evidence.
5. GitHub credentials are treated as server-side integration state, not as a frontend form value.
