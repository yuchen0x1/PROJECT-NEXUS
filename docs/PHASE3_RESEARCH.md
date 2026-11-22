# Phase 3 implementation research

Research date: 2026-11-12. The reviewed projects informed design choices only; no third-party source code was intentionally copied or added as a dependency during Phase 3.

| Source reviewed | Evidence inspected | Relevant design | License / reuse decision |
|---|---|---|---|
| GitHub REST API pagination documentation | `Link` header and `rel="next"` semantics | Consume the provider's next URL, preserve its query, and stop when no next relation is present. NEXUS additionally checks the configured API origin, caps pages and detects a repeated URL. | Official documentation consulted for API behavior; no source code was reused. |
| Octokit `plugin-paginate-rest.js` | `src/iterator.ts`, package README and license | Its iterator requests the `rel="next"` URL and normalizes endpoints whose returned array is nested under a property. NEXUS uses a smaller local helper to avoid another runtime dependency and adds explicit origin, page and loop limits. | Upstream repository is marked MIT. No source was copied; no dependency was added. |
| OpenHands Docker sandbox and software-agent SDK | Docker sandbox guidance, agent-server Dockerfile, and SDK license | A dedicated runtime image and repository workspace improve reproducibility; prebuilt runtimes can include language dependencies. NEXUS currently uses per-job clones and a generic network-disabled Docker runner. This highlighted a remaining gap: generic offline images may not have dependencies needed by target repositories. | The reviewed OpenHands repositories are marked MIT. No source was copied or adapted; check path-specific terms before any future reuse. |
| SWE-agent | `sweagent/run/run_single.py`, Docker installation guidance and license | Docker is the default execution backend; local patch application and PR creation are separate opt-in actions (`open_pr` defaults false). NEXUS similarly keeps local patch preparation separate from remote branch/PR writes. | Upstream repository is marked MIT. No source was copied or adapted. |

## Decisions and follow-up

- Use GitHub's provided pagination links rather than infer completion from repository names or an assumed short page alone. The helper remains bounded to 20 pages and reports truncation.
- Keep external dependencies unchanged. A self-contained pagination helper is enough for the current three repository-list flows and keeps installation and supply-chain surface smaller.
- Keep AI source modification inside an isolated clone and never run target repository shell commands directly on the host.
- Keep the PR operation separate from generation and disabled by default. The current process-level role is not authenticated user identity; this remains a production blocker.
- Resolve sandbox reproducibility before relying on AI changes: build/cache framework-specific test images or provide a controlled dependency cache while preserving the no-network execution boundary.
- No code transplant was selected. No third-party source attribution or license compatibility changes were needed for the Phase 3 implementation.

## Primary references

- [Octokit pagination plugin repository](https://github.com/octokit/plugin-paginate-rest.js)
- [OpenHands application repository](https://github.com/OpenHands/OpenHands) and [software-agent SDK license](https://github.com/OpenHands/software-agent-sdk/blob/main/LICENSE)
- [SWE-agent repository](https://github.com/SWE-agent/SWE-agent)
