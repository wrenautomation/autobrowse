output "env_store_path" {
  description = "The env store: `autobrowse env push` writes here."
  value       = local.env_store_path
}

output "shots_bucket" {
  description = "SHOTS_BUCKET: where screenshots ship (`autobrowse env set SHOTS_BUCKET <it>`)."
  value       = aws_s3_bucket.shots.bucket
}

output "owner_role_arn" {
  description = "AUTOBROWSE_OWNER_ROLE_ARN: every non-default owner's process assumes it, tagged owner=<name> (designs/2026-09-30-owner-keys.md)."
  value       = aws_iam_role.owners.arn
}
