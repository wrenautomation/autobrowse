# `autobrowse env push` from a laptop and by the worker's `keep` (prod sink).
# Parameters are data, not resources. The AWS box that read it at deploy was
# retired 2026-10-02 (cost); workers run on the operator's Mac (`deploy/desk`).
locals {
  env_store_path = "/autobrowse/config"
  env_store_arn  = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter${local.env_store_path}"
}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}
