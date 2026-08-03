#!/usr/bin/env bash
set -euo pipefail

deploy_env_file="${1:-.env.deploy}"
if [[ ! -f "$deploy_env_file" ]]; then
  echo "Missing ${deploy_env_file}. Copy .env.deploy.example and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$deploy_env_file"
set +a

: "${TF_VAR_project_id:?Set TF_VAR_project_id in ${deploy_env_file}}"
: "${TF_VAR_billing_account:?Set TF_VAR_billing_account in ${deploy_env_file}}"
: "${TF_VAR_discord_application_id:?Set TF_VAR_discord_application_id in ${deploy_env_file}}"
: "${TF_VAR_discord_guild_id:?Set TF_VAR_discord_guild_id in ${deploy_env_file}}"
: "${TF_VAR_discord_public_key:?Set TF_VAR_discord_public_key in ${deploy_env_file}}"
: "${TF_VAR_admin_discord_user_ids:?Set TF_VAR_admin_discord_user_ids in ${deploy_env_file}}"

TF_VAR_region="${TF_VAR_region:-us-central1}"
image_tag="$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
TF_VAR_container_image="${TF_VAR_region}-docker.pkg.dev/${TF_VAR_project_id}/milton/app:${image_tag}"
GOOGLE_CLOUD_QUOTA_PROJECT="$TF_VAR_project_id"
export TF_VAR_region TF_VAR_container_image GOOGLE_CLOUD_QUOTA_PROJECT

terraform -chdir=infra init

secret_has_version() {
  [[ -n "$(gcloud secrets versions list "$1" \
    --project "$TF_VAR_project_id" \
    --filter='state=ENABLED' \
    --limit=1 \
    --format='value(name)')" ]]
}

for secret_name in discord-client-secret discord-bot-token session-secret openrouter-api-key; do
  if ! secret_has_version "$secret_name"; then
    echo "Secret ${secret_name} has no enabled version. Run the manual secret setup in README.md." >&2
    exit 1
  fi
done

gcloud builds submit --project "$TF_VAR_project_id" --tag "$TF_VAR_container_image" .
terraform -chdir=infra apply -auto-approve

echo "Milton deployed at $(terraform -chdir=infra output -raw service_url)"
echo "Discord interactions endpoint: $(terraform -chdir=infra output -raw discord_interactions_url)"
