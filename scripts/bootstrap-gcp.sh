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
TF_VAR_container_image="${TF_VAR_region}-docker.pkg.dev/${TF_VAR_project_id}/milton/app:not-built-yet"
GOOGLE_CLOUD_QUOTA_PROJECT="$TF_VAR_project_id"
export TF_VAR_region TF_VAR_container_image GOOGLE_CLOUD_QUOTA_PROJECT

# The state bucket must exist before Terraform can initialize, so Terraform does not manage it.
state_bucket="${TF_VAR_project_id}-tfstate"
if ! gcloud storage buckets describe "gs://${state_bucket}" >/dev/null 2>&1; then
  gcloud services enable storage.googleapis.com --project "$TF_VAR_project_id"
  gcloud storage buckets create "gs://${state_bucket}" --project "$TF_VAR_project_id" \
    --location "$TF_VAR_region" --uniform-bucket-level-access --public-access-prevention
fi
gcloud storage buckets update "gs://${state_bucket}" --versioning

terraform -chdir=infra init -backend-config="bucket=${state_bucket}"
terraform -chdir=infra apply -auto-approve \
  -target=google_artifact_registry_repository.milton \
  -target=google_secret_manager_secret.credentials

echo "Bootstrap complete. Install the four secret versions before deploying."
