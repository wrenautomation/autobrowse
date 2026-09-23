# Screenshots as signal (`autobrowse shots push`, and the worker on a timer
# and before an idle stop). Private, encrypted, in the same account as the
# vault: a shot of a settings page can show a token. Kept, never expired.
resource "aws_s3_bucket" "shots" {
  bucket = "${local.prefix}-shots-${data.aws_caller_identity.me.account_id}"
}

resource "aws_s3_bucket_public_access_block" "shots" {
  bucket                  = aws_s3_bucket.shots.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "shots" {
  bucket = aws_s3_bucket.shots.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "shots" {
  bucket = aws_s3_bucket.shots.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# The box writes shots; it never reads, lists or deletes them.
data "aws_iam_policy_document" "box_shots" {
  statement {
    sid       = "ShipShots"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.shots.arn}/*"]
  }
}

resource "aws_iam_role_policy" "box_shots" {
  name   = "box-shots"
  role   = aws_iam_role.box.id
  policy = data.aws_iam_policy_document.box_shots.json
}
