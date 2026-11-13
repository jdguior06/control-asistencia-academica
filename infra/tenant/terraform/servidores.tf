# Los 3 servidores del tenant, con solo las claves SSH; los configura Ansible
# (../../ansible/tenant.yml).
#
# Imagen: la propia más reciente (asistencia-tenant-*, la crea ../../packer) si existe
# en la región; si no, Amazon Linux 2023 y Ansible instala todo (más lento).

data "aws_ami_ids" "propia" {
  owners = ["self"]

  filter {
    name   = "name"
    values = ["asistencia-tenant-*"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

data "aws_ssm_parameter" "amazon_linux" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  # aws_ami_ids las devuelve de la más nueva a la más vieja.
  imagen = var.usar_imagen && length(data.aws_ami_ids.propia.ids) > 0 ? data.aws_ami_ids.propia.ids[0] : data.aws_ssm_parameter.amazon_linux.insecure_value
}

resource "aws_instance" "servidor" {
  for_each = toset(local.roles)

  ami                    = local.imagen
  instance_type          = local.tamanos[each.key].tipo
  subnet_id              = aws_subnet.tenant.id
  private_ip             = cidrhost(local.subred, local.ip_final[each.key])
  vpc_security_group_ids = [aws_security_group.servidor[each.key].id]

  user_data                   = local.user_data
  user_data_replace_on_change = true

  root_block_device {
    volume_size = local.tamanos[each.key].disco
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required" # IMDSv2
  }

  lifecycle {
    # Una imagen nueva no recrea los servidores que ya existen (se perderían los datos).
    ignore_changes = [ami]

    # Mejor un error claro aquí que el de AWS a mitad del apply.
    precondition {
      condition     = contains(local.tipos_permitidos, local.tamanos[each.key].tipo)
      error_message = "El tipo ${local.tamanos[each.key].tipo} (${each.key}) no está permitido en el plan gratuito de AWS. Usa uno de: ${join(", ", local.tipos_permitidos)}."
    }
  }

  # Name y Rol también los lee Prometheus (etiquetas servidor y rol).
  tags = {
    Name = "${var.slug}-${each.key}"
    Rol  = each.key
  }
}
