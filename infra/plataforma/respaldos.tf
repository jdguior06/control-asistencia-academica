# Respaldos de las bases de los tenants (RF-19). El worker hace pg_dump de cada tenant y
# sube el archivo aquí: s3://<bucket>/tenants/<slug>/<fecha>.dump. Privado y cifrado; el
# worker borra los respaldos que exceden la retención del plan y, por seguridad, S3 borra
# cualquier respaldo de más de 90 días.
resource "aws_s3_bucket" "respaldos" {
  bucket        = "asistencia-respaldos-${data.aws_caller_identity.actual.account_id}"
  force_destroy = true # proyecto académico: "terraform destroy" también borra los respaldos
}

resource "aws_s3_bucket_public_access_block" "respaldos" {
  bucket                  = aws_s3_bucket.respaldos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "respaldos" {
  bucket = aws_s3_bucket.respaldos.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "respaldos" {
  bucket = aws_s3_bucket.respaldos.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "respaldos" {
  bucket = aws_s3_bucket.respaldos.id
  rule {
    id     = "maximo-90-dias"
    status = "Enabled"
    filter {
      prefix = "tenants/"
    }
    expiration {
      days = 90
    }
  }
}
