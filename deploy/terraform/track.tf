# wren-track sessions (designs/2026-10-13-track.md): every input and screen a
# person's laptop records, shipped here by one write-only IAM user per device
# (`autobrowse track enroll`). Private, encrypted, kept. Segments are read
# rarely (a training run), so after 30 days they sit in Glacier Instant
# Retrieval: cheap, still read in milliseconds.
resource "aws_s3_bucket" "track" {
  bucket = "${local.prefix}-track-${data.aws_caller_identity.me.account_id}"
}

resource "aws_s3_bucket_public_access_block" "track" {
  bucket                  = aws_s3_bucket.track.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "track" {
  bucket = aws_s3_bucket.track.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "track" {
  bucket = aws_s3_bucket.track.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "track" {
  bucket = aws_s3_bucket.track.id
  rule {
    id     = "cold-after-30-days"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
    # A laptop that drops off mid-upload leaves parts that cost until aborted.
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}
