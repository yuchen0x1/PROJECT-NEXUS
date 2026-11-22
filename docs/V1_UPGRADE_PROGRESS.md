# Ordered upgrade acceptance

Upgrade work extends the existing engine and preserves the JSON data format. No new database or infrastructure is introduced.

| Order | Scope | Status | Evidence |
|---|---|---|---|
| 1 | Execution/delivery states, live permissions, setup readiness | PASS (focused) | 20 tests, four files; typecheck |
| 2 | Durable effects, repository lease, recovery | PASS (focused) | 16 tests: intent durability, response loss, exact reconciliation, lease exclusion |
| 3 | Host restart limits, execution trust and process lifetime | PASS (focused) | 21 executor/tool tests + host crash child-cleanup test |
| 4 | Remote CI gates, release plan and adapters | PARTIAL | Local gates/plans/proposals passed; real fix/PR succeeded, Checks API 403 blocked merge; non-Node packaging not implemented |
| 5 | Visible task outcomes, approval UX, packaging and acceptance | PARTIAL | Real desktop/i18n/installed runner passed; 0.4.0 installed, profile preserved; signing and long soak unavailable/not run |

Completion requires actual test evidence. Signing, public release, and a 24-hour soak are separate acceptance items and must not be inferred from a build.

Final regression: 42 files / 225 tests PASS. Additional focused runner/host and policy/API checks passed after packaging fixes. Dedicated test repository deleted (DELETE 204, GET 404). See [current report](ORDERED_UPGRADE_REPORT.md) for exact installer hash, backup, evidence and unimplemented criteria. No commit, push or public release of this project was performed.
