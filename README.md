# Milton

Milton is a private full-text search engine for links shared in Discord. It runs as one Node/TypeScript service on Cloud Run, stores its reconstructible index in Firestore Enterprise (Native mode), and sends extraction work through separate live and historical Cloud Tasks queues.

The service fetches server-rendered HTML directly. Mozilla Readability is tried first, followed by JSON-LD `articleBody` and OpenGraph/description metadata. A failed extraction remains a searchable title/domain/link record with its Discord backlink and a structured failure class. Chrome is intentionally not part of the initial deployment.

## Architecture

- Cloud Scheduler invokes the OIDC-protected `/internal/poll` endpoint every five minutes.
- Discord cursors are persisted per channel. Existing history is read in resumable 100-message pages; live cursors advance only after message persistence succeeds.
- Firestore collections are `articles`, `occurrences`, `discordCursors`, `extractionJobs`, and `systemState`. Article IDs and occurrence IDs are deterministic SHA-256 values, making redelivery idempotent.
- Each article embeds its latest Discord occurrence, so search results require no join.
- `milton-live-extraction` and `milton-history-extraction` are independent Cloud Tasks queues. Live reposts can promote pending historical jobs.
- Extraction uses a 15-second timeout, no more than five redirects, a 2 MiB response cap, HTML content-type checks, DNS pinning, and rejection of every hostname that resolves to any non-public address.
- Bodies are capped at 32 KiB. Extraction method, hostname, status, content length, and failure class are stored with the article.
- Discord OAuth sessions last eight hours and require current membership in the configured guild.
- Google-signed ID tokens are verified again in the app for `/internal/*`; only the configured scheduler and task service accounts are accepted.

## Local development

Requirements are Node.js 22 or newer and Application Default Credentials with Firestore/Cloud Tasks access. Copy `.env.example` to `.env`, then run the API and UI in separate terminals:

```sh
npm install
npm run dev:server
npm run dev
```

For local handler testing only, set `ALLOW_UNAUTHENTICATED_INTERNAL=true` and leave `NODE_ENV` other than `production`. This bypass is deliberately ignored in production.

Run all checks with:

```sh
npm run check
```

## Provision a new GCP project

The Terraform in `infra/` treats an existing dedicated project as an input, enables the required APIs, and creates a named `milton` Enterprise Native-mode Firestore database, Artifact Registry, the two queues, three least-privilege service accounts, Secret Manager containers, and a $1 monthly billing budget. Enterprise currently rejects the `(default)` database ID. Project creation and billing attachment deliberately remain outside the application stack. It never touches a database in another project.

```sh
cd infra
terraform init
terraform apply \
  -var='project_id=YOUR_NEW_PROJECT_ID' \
  -var='billing_account=YOUR_BILLING_ACCOUNT_ID' \
  -var='container_image=us-central1-docker.pkg.dev/YOUR_NEW_PROJECT_ID/milton/app:TAG' \
  -var='discord_application_id=YOUR_APPLICATION_ID' \
  -var='discord_guild_id=YOUR_GUILD_ID' \
  -var='admin_discord_user_ids=123,456'
cd ..
```

Add secret versions without putting values in Terraform state or this repository:

```sh
printf '%s' "$DISCORD_CLIENT_SECRET" | gcloud secrets versions add discord-client-secret --project YOUR_NEW_PROJECT_ID --data-file=-
printf '%s' "$DISCORD_BOT_TOKEN" | gcloud secrets versions add discord-bot-token --project YOUR_NEW_PROJECT_ID --data-file=-
openssl rand -base64 48 | gcloud secrets versions add session-secret --project YOUR_NEW_PROJECT_ID --data-file=-
```

The current Google Terraform provider provisions the preview text index over `title`, `domain`, and `body`. If the preview API rejects that resource in your project, use the documented console fallback: Firestore → `milton` → Indexes, create one **Text** index for collection `articles`, query scope **Collection**, and those same three fields.

## Deploy

Authenticate `gcloud`, export the non-secret settings, and run:

```sh
export GOOGLE_CLOUD_PROJECT=YOUR_NEW_PROJECT_ID
export BILLING_ACCOUNT=YOUR_BILLING_ACCOUNT_ID
export DISCORD_APPLICATION_ID=...
export DISCORD_GUILD_ID=...
export ADMIN_DISCORD_USER_IDS=123,456
./scripts/deploy-gcp.sh
```

The script only builds the image and passes its version to Terraform. Terraform owns Cloud Run, its public invoker policy, all runtime configuration, and the five-minute Scheduler job. Cloud Run uses request-based billing, 1 vCPU, 1 GiB RAM, zero minimum/two maximum instances, concurrency 20, and a 60-second timeout. Secret values remain outside Terraform state.

## Discord application setup

In the Discord Developer Portal:

1. Under **OAuth2 → General → Redirects**, add the exact Terraform `oauth_callback_url` output. Discord requires an exact match, including `https` and `/auth/callback`.
2. No user OAuth scopes need to be preconfigured in the portal. Milton's login route requests `identify` and `guilds.members.read`; the latter is used only to confirm membership in the configured guild.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. Do not enable Server Members or Presence intents for Milton.
4. Install the bot to the guild with the `bot` scope and only **View Channels** plus **Read Message History** (permission bitfield `66560`). No slash-command, send-message, manage-server, or administrator permission is required.
5. Use per-channel permission overrides if Milton should index only part of the guild.

For application `1533547556905160795`, the minimal guild-install URL is:

```text
https://discord.com/oauth2/authorize?client_id=1533547556905160795&permissions=66560&integration_type=0&scope=bot
```

Sign in as a configured administrator and select **Start historical backfill**. No old Datastore, D1, Turso, or Algolia migration is expected: Discord history is the source of truth.

## Operations and acceptance

- A URL repost creates another occurrence without duplicating the article or extraction job.
- Cloud Tasks names are deterministic, claims are transactional, and temporary failures retry up to three deliveries. Permanent failures become link-only records immediately.
- Review `extractionFailureClass` grouped by `extractionHostname` after the backfill. Test a browser on a representative 20-URL sample only if at least 20 useful JS-only failures, or more than 10% of useful links, fail HTTP extraction.
- Verify representative phrase, exclusion, Unicode, and relevance searches; conversation backlinks; OAuth rejection outside the guild; cursor resumption; and discovery within roughly five minutes.
- The two-instance cap and queue dispatch limits bound load. The $1 budget is an alert, not a hard spending cap.
