output "project_number" { value = data.google_project.milton.number }
output "runtime_service_account" { value = google_service_account.runtime.email }
output "task_service_account" { value = google_service_account.tasks.email }
output "scheduler_service_account" { value = google_service_account.scheduler.email }
output "artifact_repository" { value = google_artifact_registry_repository.milton.name }
output "service_url" { value = local.service_url }
output "oauth_callback_url" { value = "${local.service_url}/auth/callback" }
