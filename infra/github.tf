# Keyless deployment from GitHub Actions (.github/workflows/ci.yml). The deployer can push images
# and roll out revisions of this service; all other infrastructure changes stay with Terraform.
# A new revision runs as the runtime account, so deployed code can still reach whatever it can.

resource "google_iam_workload_identity_pool" "github" {
  project                   = data.google_project.milton.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = data.google_project.milton.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "milton"

  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }

  # Numeric IDs survive renames and cannot be claimed by someone reusing a name. Only pushes to
  # master get credentials, never pull requests.
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.github_repository_id}'",
    "assertion.ref == 'refs/heads/master'",
    "assertion.event_name == 'push'",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deployer" {
  project      = data.google_project.milton.project_id
  account_id   = "milton-deployer"
  display_name = "Milton GitHub Actions deployer"
}

resource "google_service_account_iam_member" "deployer_github" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  project    = google_artifact_registry_repository.milton.project
  location   = google_artifact_registry_repository.milton.location
  repository = google_artifact_registry_repository.milton.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_cloud_run_v2_service_iam_member" "deployer_rollout" {
  project  = google_cloud_run_v2_service.milton.project
  location = google_cloud_run_v2_service.milton.location
  name     = google_cloud_run_v2_service.milton.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_runtime_act_as" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
