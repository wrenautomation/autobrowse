output "instance_id" {
  description = "GitHub secret INSTANCE_ID; also `aws ssm start-session --target <id>` for a shell (no SSH)."
  value       = aws_instance.box.id
}

output "ecr_repository" {
  description = "GitHub secret ECR_REPOSITORY (the full registry URL)."
  value       = aws_ecr_repository.worker.repository_url
}

output "ci_role_arn" {
  description = "GitHub secret AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.ci.arn
}

output "env_store_path" {
  description = "The env store: `autobrowse env push` writes here, the box reads it at deploy."
  value       = local.env_store_path
}

output "ui_forward" {
  description = "The UI, from a laptop, without opening a port."
  value       = "aws ssm start-session --target ${aws_instance.box.id} --document-name AWS-StartPortForwardingSession --parameters '{\"portNumber\":[\"9080\"],\"localPortNumber\":[\"9080\"]}'"
}
