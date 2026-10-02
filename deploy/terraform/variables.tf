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
