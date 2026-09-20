# autobrowse production: one small EC2 box running the worker container from
# ECR, its state on its own EBS volume, secrets in one SSM parameter, no
# inbound port at all (Restate Cloud is reached by an outbound tunnel; the UI
# is reached by SSM port forwarding), CI deploys over GitHub OIDC + SSM
# RunCommand. Same account and region as wren; the GitHub OIDC provider is
# wren's, read here, not created twice.
#
# State is local (terraform.tfstate, gitignored): one operator, one environment.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = var.name, env = var.env, managed = "terraform" }
  }
}

locals {
  prefix   = "${var.name}-${var.env}"
  ssm_root = "/${var.name}/${var.env}"
}

data "aws_caller_identity" "me" {}
