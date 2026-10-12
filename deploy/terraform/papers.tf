# Papers: identity documents for verification forms (`autobrowse papers`,
# designs/2026-10-12-papers.md). The Mac keeps them sealed; this is the backup.
# Only William's own AWS user may read, write or list it: the bucket policy
# denies every other principal in the account, so no machine role, Lambda,
# box or owner role reaches it whatever its own policy grants. Versioned, so
# a bad put or delete is recoverable.
resource "aws_s3_bucket" "papers" {
  bucket = "${local.prefix}-papers-${data.aws_caller_identity.me.account_id}"
}

resource "aws_s3_bucket_public_access_block" "papers" {
  bucket                  = aws_s3_bucket.papers.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "papers" {
  bucket = aws_s3_bucket.papers.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "papers" {
  bucket = aws_s3_bucket.papers.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "papers" {
  bucket = aws_s3_bucket.papers.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Old versions go after 90 days: a removed licence does not linger forever.
resource "aws_s3_bucket_lifecycle_configuration" "papers" {
  bucket = aws_s3_bucket.papers.id
  rule {
    id     = "old-versions-expire"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

variable "papers_reader_arn" {
  description = "The one principal that may touch the papers bucket: William's IAM user."
  type        = string
  default     = ""
}

locals {
  papers_reader = var.papers_reader_arn != "" ? var.papers_reader_arn : "arn:aws:iam::${data.aws_caller_identity.me.account_id}:user/william"
}

resource "aws_s3_bucket_policy" "papers" {
  bucket = aws_s3_bucket.papers.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "OnlyWilliam"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.papers.arn, "${aws_s3_bucket.papers.arn}/*"]
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = local.papers_reader } }
      },
      {
        Sid       = "TlsOnly"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.papers.arn, "${aws_s3_bucket.papers.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}
