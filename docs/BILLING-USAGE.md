# Codespaces usage

The console requests `/user` and `/users/{username}/settings/billing/usage` on the server.
The billing request uses `year` and `month`, `Accept: application/vnd.github+json`, and API version `2026-03-10`.
Only Codespaces items in the UTC calendar month contribute to the report.
Compute machine-hours are multiplied by the SKU core count. Core-hours are already weighted.
Storage includes prebuild storage. GB-hours are divided by the calendar month's hours to display GB-month.
Unknown units or malformed reports fall back to the local estimate.

The cache lasts ten minutes per user and month. OAuth completion invalidates that user's cache.
The countdown adds Emuly time since the cached report, with the full local estimate as a lower bound.
It cannot observe other codespaces' live activity or correct GitHub's reporting delay.
The REST usage API and automatic stop continue to use the local estimate.

Migration 5 preserves existing saved allowances as overrides.
New settings saves create an override only when an allowance is explicitly submitted.
Restoring automatic allowance clears the override. An unknown plan uses the Free allowance and is labeled unverified.
The last known plan remains available during an outage.

**Current state (2026-11-09):** login asks for `codespace` only, and no UI links to `/auth/start?billing=1`.
So the billing report is normally unavailable, and the strip counts only Emuly phone runs.
Codespaces used outside Emuly are not counted. An `InfoTip` on the strip says this.
The `user` scope was not added to the UI because it gives full profile read/write access
and its access to the billing endpoint is not confirmed. A GitHub App has a read-only "Plan" permission instead.

Billing connection adds optional `user` to the existing OAuth `codespace` scope.
Login requires only `codespace`. Declining the billing request preserves the existing session.
Reconnecting billing cannot switch the signed-in account.
No tokens are included in URLs, reports, cache keys, or browser props.

## Documentation checked on 2026-11-07

- [Codespaces billing](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces) confirms Free 120 core-hours / 15 GB-month and Pro 180 / 20.
- [Product and SKU names](https://docs.github.com/en/billing/reference/product-and-sku-names) lists compute `d2`, `d4`, `d8`, `d16`, `d32` and storage/prebuild SKUs.
- [Billing usage REST docs](https://docs.github.com/en/rest/billing/usage) have inconsistent rendered and indexed content. Indexed content lists the requested user endpoint, year/month, API version, and GitHub App `Plan: read` permission.
- The supplied enhanced-billing documentation URL redirects to budgets documentation.
- The private `/user` response requires `read:user` or `user`, according to [user REST docs](https://docs.github.com/en/rest/users/users).
- Classic OAuth `user` access to the billing endpoint could not be confirmed from current documentation. The requested scope is implemented, with fallback for 401/403/404 and unavailable access.
- A supported Codespaces URL filter could not be confirmed. The app uses the plain GitHub billing usage URL.
- GitHub documents GB-hours and GB-month, but the Codespaces page does not explicitly define the conversion denominator. The implementation uses the calendar month's hours.

Tests use synthetic tokens, mocked HTTP, temporary databases, and injected clocks.
Live billing responses, browser rendering, and consent/denial through GitHub have not been verified.
