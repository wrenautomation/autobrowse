variable "region" {
  description = "Beside wren and the Restate Cloud `us` region."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  type    = string
  default = "autobrowse"
}

variable "env" {
  type    = string
  default = "prod"
}

variable "instance_type" {
  description = "x86: the image is built on GitHub's amd64 runners. 4 GB is Chromium's floor with headroom for one flow at a time."
  type        = string
  default     = "t3.medium"
}

variable "volume_gb" {
  description = "/data: browser profiles, artifacts, recordings, compiled flows. Separate from the root disk so the instance is disposable."
  type        = number
  default     = 20
}

variable "github_repo" {
  description = "owner/name; CI on its main branch may push the image and run the deploy script on the box."
  type        = string
  default     = "wrenautomation/autobrowse"
}

variable "github_sub_prefix" {
  description = "The repo's OIDC sub prefix when GitHub uses immutable subjects (repo:owner@id/name@id); `gh api repos/{owner}/{repo}/actions/oidc/customization/sub` shows it. Empty = plain repo:owner/name only."
  type        = string
  default     = ""
}
