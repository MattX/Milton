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

variable "discord_public_key" {
  type = string
}

variable "admin_discord_user_ids" {
  description = "Comma-separated Discord user IDs allowed to use admin endpoints."
  type        = string
}

variable "openrouter_model" {
  type    = string
  default = "openai/gpt-5.6-luna"
}

variable "openrouter_reasoning_effort" {
  type    = string
  default = "medium"
  validation {
    condition     = contains(["max", "xhigh", "high", "medium", "low", "minimal", "none"], var.openrouter_reasoning_effort)
    error_message = "OpenRouter reasoning effort is invalid."
  }
}
