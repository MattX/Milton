data "google_project" "milton" {
  project_id = var.project_id
}

locals {
  services = toset([
    "artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "cloudresourcemanager.googleapis.com",
    "firestore.googleapis.com", "run.googleapis.com", "secretmanager.googleapis.com",
    "cloudtasks.googleapis.com", "cloudscheduler.googleapis.com", "iamcredentials.googleapis.com",
    "billingbudgets.googleapis.com",
  ])
  service_name = "milton"
  service_url  = "https://milton-${data.google_project.milton.number}.${var.region}.run.app"
}

resource "google_project_service" "apis" {
  for_each           = local.services
  project            = data.google_project.milton.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_firestore_database" "milton" {
  provider                            = google-beta
  project                             = data.google_project.milton.project_id
  name                                = "milton"
  location_id                         = var.region
  type                                = "FIRESTORE_NATIVE"
  database_edition                    = "ENTERPRISE"
  firestore_data_access_mode          = "DATA_ACCESS_MODE_ENABLED"
  mongodb_compatible_data_access_mode = "DATA_ACCESS_MODE_DISABLED"
  delete_protection_state             = "DELETE_PROTECTION_ENABLED"
  deletion_policy                     = "ABANDON"
  depends_on                          = [google_project_service.apis]
}

locals {
  # Only composite indexes belong here: Firestore maintains single-field indexes automatically.
  firestore_indexes = {
    jobs_priority_status = {
      collection = "extractionJobs"
      fields = [
        { path = "priority", order = "ASCENDING" },
        { path = "status", order = "ASCENDING" },
      ]
    }
    jobs_stalled = {
      collection = "extractionJobs"
      fields = [
        { path = "status", order = "ASCENDING" },
        { path = "processingStartedAt", order = "ASCENDING" },
      ]
    }
    cursors_live = {
      collection = "discordCursors"
      fields = [
        { path = "archived", order = "ASCENDING" },
        { path = "updatedAt", order = "ASCENDING" },
      ]
    }
    cursors_live_threads = {
      collection = "discordCursors"
      fields = [
        { path = "isThread", order = "ASCENDING" },
        { path = "archived", order = "ASCENDING" },
      ]
    }
    cursors_backfill = {
      collection = "discordCursors"
      fields = [
        { path = "backfillComplete", order = "ASCENDING" },
        { path = "updatedAt", order = "ASCENDING" },
      ]
    }
  }
}

resource "google_firestore_index" "application" {
  for_each    = local.firestore_indexes
  project     = data.google_project.milton.project_id
  database    = google_firestore_database.milton.name
  collection  = each.value.collection
  query_scope = "COLLECTION"
  density     = "DENSE"

  dynamic "fields" {
    for_each = each.value.fields
    content {
      field_path = fields.value.path
      order      = fields.value.order
    }
  }
}

resource "google_firestore_index" "article_text" {
  provider    = google-beta
  project     = data.google_project.milton.project_id
  database    = google_firestore_database.milton.name
  collection  = "articles"
  query_scope = "COLLECTION"
  density     = "SPARSE_ANY"
  lifecycle {
    create_before_destroy = true
  }

  dynamic "fields" {
    for_each = toset(["title", "domain", "description", "body"])
    content {
      field_path = fields.value
      search_config {
        text_spec {
          index_specs {
            index_type = "TOKENIZED"
            match_type = "MATCH_GLOBALLY"
          }
        }
      }
    }
  }
}

resource "google_artifact_registry_repository" "milton" {
  project       = data.google_project.milton.project_id
  location      = var.region
  repository_id = "milton"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "google_service_account" "runtime" {
  project      = data.google_project.milton.project_id
  account_id   = "milton-runtime"
  display_name = "Milton Cloud Run runtime"
}
resource "google_service_account" "tasks" {
  project      = data.google_project.milton.project_id
  account_id   = "milton-tasks"
  display_name = "Milton Cloud Tasks caller"
}
resource "google_service_account" "scheduler" {
  project      = data.google_project.milton.project_id
  account_id   = "milton-scheduler"
  display_name = "Milton Cloud Scheduler caller"
}

resource "google_project_iam_member" "runtime_roles" {
  for_each = toset(["roles/datastore.user", "roles/cloudtasks.enqueuer", "roles/secretmanager.secretAccessor"])
  project  = data.google_project.milton.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_service_account_iam_member" "tasks_token_creator" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.milton.number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
  depends_on         = [google_project_service.apis]
}

# Creating a task with an OIDC identity requires the creator to be allowed to act as that identity.
resource "google_service_account_iam_member" "runtime_tasks_act_as" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_tasks_queue" "live" {
  project  = data.google_project.milton.project_id
  name     = "milton-live-extraction"
  location = var.region
  rate_limits {
    max_concurrent_dispatches = 2
    max_dispatches_per_second = 2
  }
  # Three deliveries do the extraction work; the extra two cover deliveries that find the job's
  # lease still held, which must outlast the lease for a dead worker's job to be reclaimed.
  retry_config {
    max_attempts  = 5
    min_backoff   = "30s"
    max_backoff   = "600s"
    max_doublings = 3
  }
  depends_on = [google_project_service.apis]
}
resource "google_cloud_tasks_queue" "history" {
  project  = data.google_project.milton.project_id
  name     = "milton-history-extraction"
  location = var.region
  rate_limits {
    max_concurrent_dispatches = 1
    max_dispatches_per_second = 1
  }
  retry_config {
    max_attempts  = 5
    min_backoff   = "60s"
    max_backoff   = "600s"
    max_doublings = 3
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_tasks_queue" "commands" {
  project  = data.google_project.milton.project_id
  name     = "milton-commands"
  location = var.region
  rate_limits {
    max_concurrent_dispatches = 10
    max_dispatches_per_second = 2
  }
  # Digest workers catch provider failures and publish a useful fallback. A platform retry could
  # duplicate the public follow-up messages, so interactive commands receive one delivery.
  retry_config {
    max_attempts = 1
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "credentials" {
  for_each  = toset(["discord-client-secret", "discord-bot-token", "session-secret", "openrouter-api-key"])
  project   = data.google_project.milton.project_id
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service" "milton" {
  project             = data.google_project.milton.project_id
  name                = local.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account = google_service_account.runtime.email
    # One poll walks several channels and their message pages, so it needs more than a page-load
    # budget. POLL_BUDGET_MS in server/discord.ts keeps a run comfortably inside this.
    timeout                          = "300s"
    max_instance_request_concurrency = 20
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = var.container_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = false
      }

      dynamic "env" {
        for_each = {
          GOOGLE_CLOUD_PROJECT        = data.google_project.milton.project_id
          FIRESTORE_DATABASE_ID       = google_firestore_database.milton.name
          GOOGLE_CLOUD_LOCATION       = var.region
          SERVICE_URL                 = local.service_url
          LIVE_TASK_QUEUE             = google_cloud_tasks_queue.live.name
          HISTORY_TASK_QUEUE          = google_cloud_tasks_queue.history.name
          COMMAND_TASK_QUEUE          = google_cloud_tasks_queue.commands.name
          TASK_SERVICE_ACCOUNT        = google_service_account.tasks.email
          INTERNAL_SERVICE_ACCOUNTS   = "${google_service_account.tasks.email},${google_service_account.scheduler.email}"
          DISCORD_APPLICATION_ID      = var.discord_application_id
          DISCORD_GUILD_ID            = var.discord_guild_id
          DISCORD_PUBLIC_KEY          = var.discord_public_key
          ADMIN_DISCORD_USER_IDS      = var.admin_discord_user_ids
          OPENROUTER_MODEL            = var.openrouter_model
          OPENROUTER_REASONING_EFFORT = var.openrouter_reasoning_effort
        }
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = {
          DISCORD_CLIENT_SECRET = google_secret_manager_secret.credentials["discord-client-secret"].secret_id
          DISCORD_BOT_TOKEN     = google_secret_manager_secret.credentials["discord-bot-token"].secret_id
          SESSION_SECRET        = google_secret_manager_secret.credentials["session-secret"].secret_id
          OPENROUTER_API_KEY    = google_secret_manager_secret.credentials["openrouter-api-key"].secret_id
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_artifact_registry_repository.milton,
    google_project_iam_member.runtime_roles,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = google_cloud_run_v2_service.milton.project
  location = google_cloud_run_v2_service.milton.location
  name     = google_cloud_run_v2_service.milton.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_scheduler_job" "poll" {
  project          = data.google_project.milton.project_id
  region           = var.region
  name             = "milton-poll"
  description      = "Discover new Discord links every five minutes"
  schedule         = "*/5 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"

  http_target {
    uri         = "${local.service_url}/internal/poll"
    http_method = "POST"

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.service_url
    }
  }

  depends_on = [google_cloud_run_v2_service_iam_member.public]
}

resource "google_billing_budget" "one_dollar" {
  billing_account = var.billing_account
  display_name    = "Milton $1 monthly budget"
  budget_filter {
    projects = ["projects/${data.google_project.milton.number}"]
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = "1"
    }
  }
  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 1.0
  }
}
