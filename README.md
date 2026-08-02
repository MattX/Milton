# Milton

Milton is a private full-text search engine for links shared in Discord. It runs as one Node/TypeScript service on Cloud Run, stores its reconstructible index in Firestore Enterprise (Native mode), and sends extraction work through separate live and historical Cloud Tasks queues.

The service fetches server-rendered HTML directly. Mozilla Readability is tried first, followed by JSON-LD `articleBody` and OpenGraph/description metadata. A failed extraction remains a searchable title/domain/link record with its Discord backlink and a structured failure class. Chrome is intentionally not part of the initial deployment.

## Architecture

- Cloud Scheduler invokes the OIDC-protected `/internal/poll` endpoint every five minutes.
- Discord cursors are persisted per channel and seeded from the channel's `last_message_id`, so live polling starts at the present and everything behind that boundary belongs to the backfill. Live cursors advance only after message persistence succeeds, and history is read in resumable 100-message pages.
- Threads that stop being active are marked archived rather than deleted: they keep their history and stay eligible for backfill, but are no longer polled for new messages. Each polled channel also contributes its archived public threads.
- Firestore collections are `articles`, `discordCursors`, `extractionJobs`, and `systemState`. Article IDs are deterministic SHA-256 values, making redelivery idempotent.
- Each article embeds its latest Discord occurrence, so search results require no join.
- `milton-live-extraction` and `milton-history-extraction` are independent Cloud Tasks queues. Live reposts can promote pending historical jobs.
- A claimed extraction job holds a two-minute lease. A delivery that finds a live lease asks for redelivery instead of acknowledging work that may never have happened, and each poll requeues jobs whose worker died holding one.
- Extraction enforces a 15-second wall-clock budget across DNS, redirects, and the body read, plus no more than five redirects, a 2 MiB response cap, HTML content-type checks, DNS pinning, and rejection of every hostname that resolves to any non-public address.
- Pages are decoded using their declared charset, not assumed to be UTF-8.
- Bodies are capped at 32 KiB. Extraction method, hostname, status, content length, and failure class are stored with the article.
- Discord OAuth sessions last eight hours and require current membership in the configured guild.
- Google-signed ID tokens are verified again in the app for `/internal/*`; only the configured scheduler and task service accounts are accepted.

## Local development

Requirements are Node.js 22 or newer and Application Default Credentials with Firestore/Cloud Tasks access. Copy `.env.example` to `.env`, install dependencies, then run the API and UI in separate terminals:

```sh
npm install
```

```sh
# Terminal 1: API on port 8080
npm run dev:server
```

```sh
# Terminal 2: Vite UI
npm run dev
```

For local handler testing only, set `ALLOW_UNAUTHENTICATED_INTERNAL=true` and leave `NODE_ENV` other than `production`. This bypass is deliberately ignored in production.

Run all checks with:

```sh
npm run check
```

## Deploy to GCP

Prerequisites:

- Node.js 22 or newer, Terraform 1.7 or newer, and the Google Cloud CLI.
- An existing dedicated GCP project with billing attached. Project creation and billing attachment deliberately remain outside this Terraform stack.
- A Google account allowed to administer that project and create a budget on its billing account.
- A Discord application, bot token, and OAuth client secret.

Authenticate both the Google Cloud CLI and Terraform's Application Default Credentials:

```sh
gcloud auth login
gcloud auth application-default login
```

Create the ignored deployment environment file and fill in its nonsecret values:

```sh
cp .env.deploy.example .env.deploy
# Edit .env.deploy and fill in every required value.
```

Bootstrap the required APIs, Artifact Registry repository, and empty Secret Manager containers:

```sh
npm run bootstrap
```

Install the secret payloads manually. These commands prompt without echoing or placing the values in shell history:

```sh
set -a
source .env.deploy
set +a

bash -c 'read -r -s -p "Discord OAuth client secret: " value; echo; printf %s "$value" | gcloud secrets versions add discord-client-secret --project "$TF_VAR_project_id" --data-file=-'
bash -c 'read -r -s -p "Discord bot token: " value; echo; printf %s "$value" | gcloud secrets versions add discord-bot-token --project "$TF_VAR_project_id" --data-file=-'
openssl rand -base64 48 | gcloud secrets versions add session-secret --project "$TF_VAR_project_id" --data-file=-
```

Then deploy the application:

```sh
npm run deploy
```

The deploy command verifies that all three secrets have an enabled version, builds a uniquely tagged image with Cloud Build, runs the full Terraform apply, and prints the service URL. It never reads, creates, or rotates secret payloads.

Subsequent deployments need only `npm run deploy`. Rotate a credential explicitly by rerunning its `gcloud secrets versions add` command and then deploying a new revision. Rotating `session-secret` signs all users out.

Terraform owns the named `milton` Enterprise database with Firestore Native access explicitly enabled and MongoDB-compatible access disabled, all indexes, Artifact Registry, Cloud Run, queues, service accounts, IAM, secret containers, Scheduler, and the $1 monthly budget. Secret payloads never enter Terraform state or version control. State is local under `infra/` by default; configure a GCS backend before using this as a multi-operator deployment.

Cloud Run uses request-based billing, 1 vCPU, 1 GiB RAM, zero minimum/two maximum instances, concurrency 20, and a 300-second timeout that accommodates a full poll. Enterprise rejects the `(default)` database ID, so Milton uses the named database `milton`.

The current Google Terraform provider provisions the preview text index over `title`, `domain`, and `body`. If the preview API rejects that resource in a future project, use the console fallback: Firestore → `milton` → Indexes, create one **Text** index for collection `articles`, query scope **Collection**, and those same three fields.

## Discord application setup

In the Discord Developer Portal:

1. Under **OAuth2 → General → Redirects**, add the exact Terraform `oauth_callback_url` output. Discord requires an exact match, including `https` and `/auth/callback`.
2. No user OAuth scopes need to be preconfigured in the portal. Milton's login route requests `identify` and `guilds.members.read`; the latter is used only to confirm membership in the configured guild.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. Do not enable Server Members or Presence intents for Milton.
4. Install the bot to the guild with the `bot` scope and only **View Channels** plus **Read Message History** (permission bitfield `66560`). No slash-command, send-message, manage-server, or administrator permission is required.
5. Use per-channel permission overrides if Milton should index only part of the guild.

The minimal guild-install URL is:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=66560&integration_type=0&scope=bot
```

Sign in as a configured administrator and select **Start historical backfill**. No old Datastore, D1, Turso, or Algolia migration is expected: Discord history is the source of truth.

## Operations and acceptance

- A URL repost updates the article's latest occurrence without duplicating the article or extraction job.
- Cloud Tasks names are deterministic, claims are transactional, and temporary failures retry up to three extraction attempts across five deliveries. Permanent failures become link-only records immediately.
- Link-only records are not retried automatically. Sign in as an administrator and select **Retry failed extractions** to requeue them, for example after fixing an outage that failed a batch.
- Review `extractionFailureClass` grouped by `extractionHostname` after the backfill. Test a browser on a representative 20-URL sample only if at least 20 useful JS-only failures, or more than 10% of useful links, fail HTTP extraction.
- Verify representative phrase, exclusion, Unicode, and relevance searches; conversation backlinks; OAuth rejection outside the guild; cursor resumption; and discovery within roughly five minutes.
- The two-instance cap and queue dispatch limits bound load. The $1 budget is an alert, not a hard spending cap.
