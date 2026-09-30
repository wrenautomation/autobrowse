# Owners (designs/2026-09-30-owner-keys.md): one role that every non-default
# owner's process assumes with its own session tag `owner=<name>`. The policy is
# scoped by that tag, so an owner's session reaches only its own SSM path and S3
# prefixes. The default owner (wren) never assumes it; its machines are denied
# every owner's path instead (box.tf, shots.tf).

locals {
  account         = data.aws_caller_identity.me.account_id
  owner_tag       = "$${aws:PrincipalTag/owner}"
  owner_ssm_arn   = "arn:aws:ssm:${var.region}:${local.account}:parameter/autobrowse/owners"
  owner_ssm_write = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion"]
  owner_ssm_read  = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"]
}

# Anyone in this account the operator lets assume it (the box's role; the
# operator's own user), and only with exactly one tag: a plain owner name.
data "aws_iam_policy_document" "owners_assume" {
  statement {
    sid     = "OneOwnerPerSession"
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account}:root"]
    }
    condition {
      test     = "StringLike"
      variable = "aws:RequestTag/owner"
      values   = ["?*"]
    }
    condition {
      test     = "StringNotLike"
      variable = "aws:RequestTag/owner"
      values   = ["*/*"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["owner"]
    }
  }
}

resource "aws_iam_role" "owners" {
  name                 = "${local.prefix}-owners"
  description          = "autobrowse owners: one session per owner, tagged owner=<name>; reaches only that owner's SSM path and S3 prefixes"
  assume_role_policy   = data.aws_iam_policy_document.owners_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "owners" {
  statement {
    sid       = "OwnEnvStore"
    actions   = concat(local.owner_ssm_read, local.owner_ssm_write)
    resources = ["${local.owner_ssm_arn}/${local.owner_tag}", "${local.owner_ssm_arn}/${local.owner_tag}/*"]
  }
  # Listing with descriptions (expiry) has no resource scope: names, never values.
  statement {
    sid       = "ListNames"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }
  statement {
    sid       = "SsmKey"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
  statement {
    sid       = "OwnShots"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.shots.arn}/owners/${local.owner_tag}/*"]
  }
  statement {
    sid       = "OwnRunInputs"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.shots.arn}/inputs/owners/${local.owner_tag}/*"]
  }
}

resource "aws_iam_role_policy" "owners" {
  name   = "owners"
  role   = aws_iam_role.owners.id
  policy = data.aws_iam_policy_document.owners.json
}

# The box may run an owner's worker: it assumes the owners role, tagged.
data "aws_iam_policy_document" "box_owners" {
  statement {
    sid       = "BecomeAnOwner"
    actions   = ["sts:AssumeRole", "sts:TagSession"]
    resources = [aws_iam_role.owners.arn]
  }
}

resource "aws_iam_role_policy" "box_owners" {
  name   = "box-owners"
  role   = aws_iam_role.box.id
  policy = data.aws_iam_policy_document.box_owners.json
}
