# GitHub App setup

The current milestone supports a legacy fine-grained token and a GitHub App configuration record. The private key is read only by the API process from `GITHUB_APP_PRIVATE_KEY` or a server-side secret reference; it is never returned to the browser.

1. Create a GitHub App under the desired personal account or organization.
2. Set a callback URL to `/api/github/app/callback` behind your HTTPS host.
3. Set a webhook URL to `/api/github/webhook` and copy the webhook secret to `GITHUB_WEBHOOK_SECRET`.
4. Grant only repository Metadata read access plus the Actions, Contents, Pull requests, Checks, and Issues permissions required by enabled features.
5. Set `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_PRIVATE_KEY` on the server.
6. Open Settings → GitHub Connections and use the generated installation URL.
7. After installation, verify the installation and repository list in the connection status endpoint.

The generated installation URL contains a server-issued, one-time state token. The callback rejects a missing, expired, or replayed token before it contacts GitHub; request a new installation URL if the flow is interrupted.

The legacy token remains available for local development and migration. App installations are preferred for multi-repository or multi-user deployments.
