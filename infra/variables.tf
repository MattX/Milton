variable "project_id" {
  type = string
}

variable "billing_account" {
  type      = string
  sensitive = true
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "container_image" {
  description = "Immutable or versioned Artifact Registry image deployed to Cloud Run."
  type        = string
}

variable "discord_application_id" {
  type = string
}

variable "discord_guild_id" {
  type = string
}

variable "admin_discord_user_ids" {
  description = "Comma-separated Discord user IDs allowed to use admin endpoints."
  type        = string
}
