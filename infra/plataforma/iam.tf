# Permisos de los servidores (roles de IAM). No hay claves de acceso guardadas
# en ningún lado: cada servidor recibe credenciales temporales de su rol.
#
#   monitoreo   Prometheus lista los servidores EC2 de cada región (descubrimiento).
#   plataforma  El portal crea y borra tenants con Terraform, OpenTofu, Pulumi
#               o CloudFormation (etapa 5).

data "aws_caller_identity" "actual" {}

data "aws_iam_policy_document" "confiar_en_ec2" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------- monitoreo

resource "aws_iam_role" "monitoreo" {
  name               = "${var.prefijo}-monitoreo"
  assume_role_policy = data.aws_iam_policy_document.confiar_en_ec2.json
}

data "aws_iam_policy_document" "monitoreo" {
  statement {
    sid       = "DescubrirServidores"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeAvailabilityZones"]
    resources = ["*"] # las acciones Describe no admiten un recurso concreto
  }
}

resource "aws_iam_role_policy" "monitoreo" {
  name   = "descubrir-servidores"
  role   = aws_iam_role.monitoreo.id
  policy = data.aws_iam_policy_document.monitoreo.json
}

resource "aws_iam_instance_profile" "monitoreo" {
  name = "${var.prefijo}-monitoreo"
  role = aws_iam_role.monitoreo.name
}

# ---------------------------------------------------------------- plataforma (worker del portal)

resource "aws_iam_role" "plataforma" {
  name               = "${var.prefijo}-worker"
  assume_role_policy = data.aws_iam_policy_document.confiar_en_ec2.json
}

data "aws_iam_policy_document" "plataforma" {
  # Redes, firewalls, peering y servidores de los tenants, en cualquier región.
  # Es amplio a propósito (proyecto académico); en producción se limitaría con
  # condiciones sobre la etiqueta Proyecto=asistencia.
  statement {
    sid       = "TenantsEc2"
    actions   = ["ec2:*"]
    resources = ["*"]
  }

  statement {
    sid       = "TenantsCloudFormation"
    actions   = ["cloudformation:*"]
    resources = ["*"]
  }

  # Estados de Terraform/OpenTofu y Pulumi, y plantillas de CloudFormation.
  statement {
    sid       = "EstadosListar"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketVersioning"]
    resources = ["arn:aws:s3:::${var.bucket_estado}"]
  }

  statement {
    sid       = "EstadosLeerEscribir"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.bucket_estado}/*"]
  }

  # Respaldos de las bases de los tenants (respaldos.tf).
  statement {
    sid       = "RespaldosListar"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.respaldos.arn]
  }

  statement {
    sid       = "RespaldosLeerEscribir"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.respaldos.arn}/*"]
  }

  # AMI más reciente de Amazon Linux (parámetros públicos de AWS).
  statement {
    sid       = "ImagenesPublicas"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:*::parameter/aws/service/*"]
  }

  statement {
    sid       = "Identidad"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "plataforma" {
  name   = "crear-tenants"
  role   = aws_iam_role.plataforma.id
  policy = data.aws_iam_policy_document.plataforma.json
}

resource "aws_iam_instance_profile" "plataforma" {
  name = "${var.prefijo}-worker"
  role = aws_iam_role.plataforma.name
}
