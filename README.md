# Milton

Milton is a private full-text search engine for links shared in Discord. It polls selected channels, extracts readable article text with Cloudflare Browser Run, indexes it in D1/SQLite FTS5, and links every result to both the original page and Discord discussion.

The application is a TypeScript Cloudflare Worker with a React/Vite UI.

## Architecture

- A one-minute Cron Trigger polls Discord's REST API using durable per-channel cursors.
- D1 stores articles, every Discord occurrence, backfill state, quota accounting, and an FTS5 index.
- Cloudflare Queue delivers idempotent extraction jobs to Browser Run's `/markdown` Quick Action.
- New links take priority. Historical backfill pauses at the configured free-tier browser-time and backlog thresholds.
- Discord OAuth grants an eight-hour signed session only after `guilds.members.read` confirms membership in the configured server.

Reader mode is intentionally omitted. Failed extractions remain searchable by title/URL and retain their Discord backlinks.

## Local development

Requirements: Node.js 22 or newer, npm, and `sqlite3` for the schema verification test.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Browser Run Quick Actions require a remote binding. For extraction testing, authenticate Wrangler and run Vite with the remote browser binding configured through Cloudflare; ordinary UI, D1, and API development can remain local.

Run all checks with:

```sh
npm run check
```

## Cloudflare setup

The initial deployment is designed for Workers Free. Create the resources before deploying:

```sh
npx wrangler login
npx wrangler d1 create milton
npx wrangler queues create milton-extraction
npx wrangler queues create milton-extraction-dead-letter
```

Copy the returned D1 database ID into `wrangler.jsonc`. Then configure the non-secret values in `vars`:

- `DISCORD_APPLICATION_ID`
- `DISCORD_GUILD_ID`
- `DISCORD_CHANNEL_IDS`, as comma-separated IDs
- `ADMIN_DISCORD_USER_IDS`, as comma-separated IDs

Install secrets without putting them in the repository:

```sh
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put SESSION_SECRET
```

Use at least 32 random bytes for `SESSION_SECRET`, for example from `openssl rand -base64 32`.

Apply the production migration and deploy:

```sh
npm run db:migrate:remote
npm run deploy
```

## Discord setup

Create one application in the Discord Developer Portal:

1. Create its bot and enable the Message Content privileged intent.
2. Install it in the target server with only `View Channel` and `Read Message History` for channels Milton should index.
3. Add `https://YOUR_HOST/auth/callback` as an OAuth2 redirect URL.
4. Keep the bot token and OAuth client secret only in Wrangler secrets.

The OAuth login requests `identify` and `guilds.members.read`; it does not request the user's complete guild list. Discord access tokens are discarded after each membership check.

After deployment, sign in as a configured administrator. Live polling starts automatically. Use the Indexer status panel to start the historical backfill and monitor browser time, pending jobs, failures, and channel progress.

## Free-tier behavior and upgrading

Defaults reserve two of Browser Run's ten daily free minutes for newly shared links and allow backfill to consume the other eight. Backfill also pauses at 100 pending historical jobs. These thresholds can be changed with:

- `BROWSER_DAILY_LIMIT_MS`
- `BACKFILL_DAILY_BUDGET_MS`

D1 exposes no database size over SQL, so there is no storage threshold; the daily browser budget is what bounds growth. Check size with `npx wrangler d1 info milton`.

Workers Paid expands the same D1 database from 500 MB to 10 GB and raises Browser Run and CPU limits. No data migration is needed. After upgrading, increase the configured limits and redeploy so Browser Run associates the Worker with the paid plan.

## Operational behavior

- Polling and extraction are idempotent; reposting a URL creates another occurrence without another article row.
- A Discord cursor advances only after its messages have been stored.
- Extraction failures retry three times and then become link-only results.
- Queue messages are only a wake-up nudge; `extraction_jobs.next_attempt_at` is the real schedule, so quota deferrals never consume a delivery attempt.
- Active public threads are discovered continuously and backfilled like any other channel. Archived threads are not indexed.
- Each run polls a bounded number of channels, oldest-polled first, to stay inside the Workers Free subrequest budget.
- Removing someone from Discord revokes access when their current session expires, within at most eight hours.
