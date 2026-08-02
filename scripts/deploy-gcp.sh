#!/usr/bin/env bash
set -euo pipefail

: "${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT to the new Milton project ID}"
: "${BILLING_ACCOUNT:?Set BILLING_ACCOUNT to the project's billing account ID}"
: "${DISCORD_APPLICATION_ID:?Set DISCORD_APPLICATION_ID}"
: "${DISCORD_GUILD_ID:?Set DISCORD_GUILD_ID}"
: "${ADMIN_DISCORD_USER_IDS:?Set ADMIN_DISCORD_USER_IDS}"

region="${GOOGLE_CLOUD_LOCATION:-us-central1}"
image="${region}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/milton/app:$(git rev-parse --short HEAD)"

gcloud builds submit --project "$GOOGLE_CLOUD_PROJECT" --tag "$image" .

export GOOGLE_CLOUD_QUOTA_PROJECT="$GOOGLE_CLOUD_PROJECT"
terraform -chdir=infra apply \
  -var="project_id=${GOOGLE_CLOUD_PROJECT}" \
  -var="billing_account=${BILLING_ACCOUNT}" \
  -var="region=${region}" \
  -var="container_image=${image}" \
  -var="discord_application_id=${DISCORD_APPLICATION_ID}" \
  -var="discord_guild_id=${DISCORD_GUILD_ID}" \
  -var="admin_discord_user_ids=${ADMIN_DISCORD_USER_IDS}"
