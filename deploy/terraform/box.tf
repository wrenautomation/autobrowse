# The worker box. No ingress rule at all: Restate reaches it through the
# tunnel it dials, an operator reaches it through SSM (shell and port forward).

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_subnet" "box" {
  id = sort(data.aws_subnets.default.ids)[0]
}

resource "aws_security_group" "box" {
  name        = "${local.prefix}-box"
  description = "No inbound; Restate via outbound tunnel, operator via SSM"
  vpc_id      = data.aws_vpc.default.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# The env store: one SecureString per name under this path, written by
# `autobrowse env push` from a laptop and by the worker's `keep` (prod sink),
# read by the deploy script on the box. Parameters are data, not resources.
locals {
  env_store_path = "/autobrowse/config"
  env_store_arn  = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter${local.env_store_path}"
}

resource "aws_ecr_repository" "worker" {
  name                 = local.prefix
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 10 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "box" {
  name               = "${local.prefix}-box"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "box_ssm" {
  role       = aws_iam_role.box.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "box_ecr" {
  role       = aws_iam_role.box.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

data "aws_iam_policy_document" "box" {
  statement {
    sid       = "ReadEnvStore"
    actions   = ["ssm:GetParametersByPath", "ssm:GetParameter"]
    resources = [local.env_store_arn, "${local.env_store_arn}/*"]
  }
  statement {
    sid       = "MintIntoEnvStore"
    actions   = ["ssm:PutParameter"]
    resources = ["${local.env_store_arn}/*"]
  }
  statement {
    sid       = "SsmKey"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

resource "aws_iam_role_policy" "box" {
  name   = "box"
  role   = aws_iam_role.box.id
  policy = data.aws_iam_policy_document.box.json
}

# The worker stops its own machine when idle (IDLE_STOP_MINUTES): this one instance, nothing else.
# Describe cannot be scoped; it only reads the started-by tag.
data "aws_iam_policy_document" "box_self" {
  statement {
    sid       = "StopSelf"
    actions   = ["ec2:StopInstances", "ec2:DeleteTags"]
    resources = [aws_instance.box.arn]
  }
  statement {
    sid       = "ReadSelf"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "box_self" {
  name   = "box-self"
  role   = aws_iam_role.box.id
  policy = data.aws_iam_policy_document.box_self.json
}

resource "aws_iam_instance_profile" "box" {
  name = "${local.prefix}-box"
  role = aws_iam_role.box.name
}

resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.box.availability_zone
  size              = var.volume_gb
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "${local.prefix}-data" }
}

resource "aws_instance" "box" {
  ami                         = data.aws_ssm_parameter.al2023.value
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnet.box.id
  vpc_security_group_ids      = [aws_security_group.box.id]
  iam_instance_profile        = aws_iam_instance_profile.box.name
  associate_public_ip_address = true # outbound only; no rule lets anything in
  user_data_replace_on_change = false

  root_block_device {
    volume_size = 16 # the Playwright image alone is ~2 GB; room for a few
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
    # The worker runs in a container one hop away: IMDSv2 tokens must cross it (its role credentials, its instance id).
    http_put_response_hop_limit = 2
  }

  user_data = templatefile("${path.module}/user-data.sh", {
    region        = var.region
    account       = data.aws_caller_identity.me.account_id
    volume_id     = aws_ebs_volume.data.id
    ecr           = aws_ecr_repository.worker.repository_url
    compose       = file("${path.module}/../compose.prod.yml")
    deploy_script = file("${path.module}/../scripts/on-box-deploy.sh")
  })

  tags = { Name = "${local.prefix}-box" }

  lifecycle {
    # A stopped box reports no public IP; without this, a plan while it sleeps would replace it.
    ignore_changes = [ami, associate_public_ip_address]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.box.id
}
