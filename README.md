# Hoursmith

Hoursmith is a personal Jira worklog dashboard for developers, tech leads, and engineering managers who already live in Jira and just want their week to make sense. It gives you a heatmap of your logged time, focused week and day views, smart suggestions for the gaps, and one-click CSV exports — all running client-side against your own Jira instance, with no backend to operate and no third party in the middle.

![Hoursmith dashboard](docs/screenshot.png)

## Free and Premium

Hoursmith is source-available, with the app core under MIT. The whole app is in this repository; only the hosted Premium code under [`/premium`](premium) is BSL 1.1 (converting to Apache 2.0 in 2030). There is also a hosted Premium tier for people who would rather not run a local proxy.

| | Free (self-host) | Hosted | Lead |
|---|---|---|---|
| Full app, all features | Yes | Yes | Yes |
| Worklog dashboard, heatmap, reports, CSV | Yes | Yes | Yes |
| CORS proxy | You run `npm run cors-proxy` locally | We host it, you sign in | We host it, you sign in |
| Terminal required | Yes | No | No |
| Multi-client config, per-client CSV, holidays/PTO | — | — | Yes |
| Price | Free, forever | €29/year | €60/year (founding) → €120/year |
| Status | Available now | Coming soon | Coming soon |

Hosted runs the CORS proxy for you for €29/year, so you never have to keep a proxy process running on your machine. Lead adds multi-client tooling for team leads who report to more than one client — €60/year founding rate, rising to €120 as more Lead features ship, with founding subscribers locked at €60 for as long as they stay subscribed. Early Hosted subscribers get a founding rate of €19/year on the same lock. The app code is identical across tiers — you pay for hosting and the Lead conveniences, never to unlock the core app.

The paid tiers are not open for purchase yet. The [pricing page](https://hoursmith.io/pricing) is live and shows the planned tiers and prices; while checkout is gated you can join the waitlist there to be notified when it opens.

## Self-host the Free tier

Requirements: Node.js 18+ and a Jira account with an API token. Both Jira Cloud and Jira Server / Data Center are supported — point Settings at whichever host you use.

```bash
git clone https://github.com/bcamarneiro/hoursmith.git
cd hoursmith
npm install
npm run dev
```

In a second terminal:

```bash
npm run cors-proxy
```

Then open `http://localhost:5173` and finish setup from **Settings** — enter your Jira host, email, and API token (or import a backup JSON), then run the connection test in the readiness panel to confirm auth, permissions, and CORS are all in good shape.

### Why the CORS proxy?

Jira's REST API does not send CORS headers for browser clients (this applies to Jira Cloud and to most Jira Server / Data Center setups), so a pure SPA cannot call it directly from `localhost` without help. The bundled proxy (`cors-proxy.js`) is a small Node script that forwards requests from your browser to Jira on the same machine. Nothing leaves your computer.

For SOCKS5 environments, use `npm run cors-proxy:socks` instead.

## Security

Hoursmith never stores your Jira credentials. They live in your browser and are only used to sign requests to your own Jira instance.

- Your Jira host, email, and API token live in your browser's `localStorage`.
- The local CORS proxy is a transparent forwarder. It does not log, store, or persist tokens.
- The hosted Premium proxy follows the same rule. Your token stays in your browser; on each request it transits the Vercel proxy function in-flight purely to reach your Jira instance, and is never logged, stored, or persisted. The proxy is stateless.

If you stop using Hoursmith, clear site data in your browser and revoke the API token in Jira.

## License

The repository uses a split license:

- Everything at the repository root is [MIT](LICENSE). This is the app you self-host.
- Everything under [`/premium`](premium) is [BSL 1.1](premium/LICENSE). This is the code that powers the hosted Premium proxy. It is source-available so you can read and audit it, but it is not licensed for you to run a competing hosted service. It converts to Apache 2.0 on 2030-05-16.

The boundary is enforced in CI via `npm run check:premium-boundary`. If you only care about the open-source app, you can ignore `/premium` entirely.

## Releases

The repo uses two long-lived branches:

- **`staging`** — default branch. PRs merge here. Auto-deploys to a Vercel preview at `hoursmith-git-staging-bruno-camarneiros-projects.vercel.app` (or a stable `staging.hoursmith.io` once the domain is wired). The `e2e-sandbox` workflow runs against this URL after merge.
- **`main`** — production. Receives merges only from `staging`. Auto-deploys to `hoursmith.io`.

### Cutting a release

1. Make sure `staging` is green on `quality` and (once configured) `e2e-sandbox`.
2. Bump the version: `npm version patch|minor|major` — updates `package.json` *and* `VERSION` in `premium/api/version.ts`. Commit on `staging`.
3. Open a PR `staging → main`. Required checks re-run.
4. Merge. Production redeploys.
5. Tag the release: `gh release create v$(node -p "require('./package.json').version") --target main --generate-notes`.

### Knowing what's running where

`GET /api/version` returns the running version, git SHA, branch, and Vercel env. A tiny chip in the bottom-right of every page shows the same info — `v1.0.0 · abc1234 · prod` — so a customer's screenshot is matchable to an exact deploy.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

A CLA will be required before non-trivial contributions can be merged (via cla-assistant.io). The CLA bot is not yet wired up — coming soon. Small fixes and documentation tweaks are fine to send in the meantime.

## Status

Hoursmith is under active development. The open-source app is usable today; Hoursmith Premium is not yet launched. The public direction lives in [ROADMAP.md](ROADMAP.md).
