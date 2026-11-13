# Dos servidores. Se crean "vacíos" (solo con las claves SSH); los configura Ansible
# (../ansible/plataforma.yml).
#
#   plataforma  10.0.1.10  portal (web + API + su base) y gateway Nginx de los tenants
#   monitoreo   10.0.1.40  Prometheus y Grafana

locals {
  carpeta_claves = "${path.module}/../claves"
  claves_ssh = [
    for archivo in sort(fileset(local.carpeta_claves, "*.pub")) :
    trimspace(file("${local.carpeta_claves}/${archivo}"))
  ]

  # cloud-init mínimo: solo las claves SSH para que Ansible pueda entrar.
  user_data = "#cloud-config\n${yamlencode({ ssh_authorized_keys = local.claves_ssh })}"

  servidores = {
    plataforma = {
      tipo   = var.tipo_plataforma
      disco  = var.disco_plataforma_gb
      ip     = cidrhost(aws_subnet.publica.cidr_block, 10)
      grupo  = aws_security_group.plataforma.id
      perfil = aws_iam_instance_profile.plataforma.name
    }
    monitoreo = {
      tipo   = var.tipo_monitoreo
      disco  = var.disco_monitoreo_gb
      ip     = cidrhost(aws_subnet.publica.cidr_block, 40)
      grupo  = aws_security_group.monitoreo.id
      perfil = aws_iam_instance_profile.monitoreo.name
    }
  }
}

# Amazon Linux 2023 más reciente (parámetro público de AWS).
data "aws_ssm_parameter" "amazon_linux" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "servidor" {
  for_each = local.servidores

  ami                    = data.aws_ssm_parameter.amazon_linux.value
  instance_type          = each.value.tipo
  subnet_id              = aws_subnet.publica.id
  private_ip             = each.value.ip
  vpc_security_group_ids = [each.value.grupo]
  iam_instance_profile   = each.value.perfil

  user_data                   = local.user_data
  user_data_replace_on_change = true

  root_block_device {
    volume_size = each.value.disco
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required" # IMDSv2
  }

  lifecycle {
    # No recrear el servidor cuando AWS publique una imagen nueva.
    ignore_changes = [ami]

    precondition {
      condition     = length(local.claves_ssh) > 0
      error_message = "No hay claves en infra/claves/. Agrega al menos un archivo .pub."
    }
  }

  # Prometheus lee estas etiquetas (tenant, rol, servidor...).
  tags = {
    Name    = "vm-${each.key}"
    Rol     = each.key
    Plan    = "plataforma"
    Entorno = "plataforma"
  }
}

# IP fija del portal y del gateway: de ella salen todas las direcciones nip.io.
resource "aws_eip" "plataforma" {
  domain     = "vpc"
  depends_on = [aws_internet_gateway.plataforma]

  tags = { Name = "${var.prefijo}-ip" }
}

resource "aws_eip_association" "plataforma" {
  instance_id   = aws_instance.servidor["plataforma"].id
  allocation_id = aws_eip.plataforma.id
}
