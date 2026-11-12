# GitHub Webhooks

NEXUS accepts GitHub webhook deliveries at `POST /api/github/webhook`.

- Signature: `X-Hub-Signature-256: sha256=<HMAC-SHA256>`.
- Event type: `X-GitHub-Event`.
- Delivery id: `X-GitHub-Delivery`.
- The raw request body is verified before JSON parsing.
- Duplicate delivery IDs are acknowledged without reprocessing.
- Accepted events are persisted and queued for lightweight state updates.
- Expensive follow-up work belongs in the task worker, not the request handler.

For local development without a public HTTPS endpoint, use the existing API polling endpoints. The UI must label polling data as polling data; webhook delivery is never inferred from a successful API read.
