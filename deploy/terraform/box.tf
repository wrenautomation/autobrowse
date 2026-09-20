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

# Every secret the worker reads, as one JSON object; deploy/scripts/push-secrets.sh
# writes it. Terraform only creates the slot and never sees the content again.
resource "aws_ssm_parameter" "env" {
  name  = "${local.ssm_root}/env"
  type  = "SecureString"
  tier  = "Advanced"
  value = "{}"
  lifecycle {
    ignore_changes = [value]
  }
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
    sid       = "ReadOwnEnv"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.env.arn]
  }
  statement {
    sid       = "DecryptSsm"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

resource "aws_iam_role_policy" "box" {
  name   = "box"
  role   = aws_iam_role.box.id
  policy = data.aws_iam_policy_document.box.json
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
  }

  user_data = templatefile("${path.module}/user-data.sh", {
    region    = var.region
    account   = data.aws_caller_identity.me.account_id
    volume_id = aws_ebs_volume.data.id
    env_param = aws_ssm_parameter.env.name
    ecr       = aws_ecr_repository.worker.repository_url
    compose   = file("${path.module}/../compose.prod.yml")
  })

  tags = { Name = "${local.prefix}-box" }

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.box.id
}
