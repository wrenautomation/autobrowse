# GitHub Actions on main deploys through OIDC: push the image to ECR, then run
# the box's deploy script over SSM RunCommand. The role can do those two things
# and read the result; it cannot touch the instance, secrets or IAM.
# The account's one GitHub OIDC provider belongs to wren's terraform.

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "ci_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = flatten([
        for prefix in distinct(["repo:${var.github_repo}", var.github_sub_prefix]) : [
          "${prefix}:ref:refs/heads/main",
          "${prefix}:environment:production",
        ] if prefix != ""
      ])
    }
  }
}

resource "aws_iam_role" "ci" {
  name               = "${local.prefix}-ci"
  assume_role_policy = data.aws_iam_policy_document.ci_assume.json
}

data "aws_iam_policy_document" "ci" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.worker.arn]
  }
  statement {
    sid       = "StartStopBox"
    actions   = ["ec2:StartInstances", "ec2:StopInstances"]
    resources = [aws_instance.box.arn]
  }
  statement {
    sid       = "SeeBox"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus", "ssm:DescribeInstanceInformation"]
    resources = ["*"]
  }
  statement {
    sid       = "RunDeployOnBox"
    actions   = ["ssm:SendCommand"]
    resources = [aws_instance.box.arn, "arn:aws:ssm:${var.region}::document/AWS-RunShellScript"]
  }
  statement {
    sid       = "ReadDeployResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ci" {
  name   = "deploy-worker"
  role   = aws_iam_role.ci.id
  policy = data.aws_iam_policy_document.ci.json
}
