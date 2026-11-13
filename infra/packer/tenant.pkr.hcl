# Imagen (AMI) de los servidores de los tenants, con todo lo que tarda ya instalado:
# Node.js, Nginx, PostgreSQL, el código compilado y los agentes de monitoreo.
#
# Packer crea un servidor temporal, ejecuta imagen.yml (las MISMAS tareas de Ansible
# de infra/ansible/tareas) y guarda el disco como AMI. Después:
#   - los 4 motores usan la imagen más reciente "asistencia-tenant-*" (si existe);
#   - tenant.yml solo configura lo propio de cada tenant: pasa de 10-15 a 2-3 minutos.
#
#   cd infra\packer
#   packer init .
#   packer build .
#
# Volver a crearla cuando cambie el código de la app o la lista de paquetes.

packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "~> 1.3"
    }
  }
}

variable "region" {
  type        = string
  default     = "us-east-2"
  description = "Región donde se construye la imagen."
}

variable "copiar_a" {
  type        = list(string)
  default     = ["us-east-1", "us-west-2"]
  description = "Otras regiones donde se copia la imagen (las de los tenants)."
}

variable "tipo" {
  type        = string
  default     = "t3.small" # plan gratuito; 2 GB alcanzan para compilar (con swap)
  description = "Tipo del servidor temporal."
}

locals {
  fecha = formatdate("YYYYMMDD-hhmm", timestamp())
}

source "amazon-ebs" "tenant" {
  region        = var.region
  ami_regions   = var.copiar_a
  instance_type = var.tipo
  ssh_username  = "ec2-user"

  # Amazon Linux 2023 más reciente (la misma base que usan los tenants sin imagen propia).
  source_ami_filter {
    filters = {
      name                = "al2023-ami-2023.*-kernel-*-x86_64"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    owners      = ["amazon"]
    most_recent = true
  }

  # Disco de 20 GB: el mínimo de los planes (los servidores pueden tener más, no menos).
  # Sin cifrar en la imagen: no tiene secretos; cada servidor se cifra al crearse.
  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 20
    volume_type           = "gp3"
    delete_on_termination = true
  }

  # SSH del servidor temporal: solo desde tu IP.
  temporary_security_group_source_public_ip = true

  metadata_options {
    http_tokens                 = "required" # IMDSv2
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }
  imds_support = "v2.0"

  ami_name        = "asistencia-tenant-${local.fecha}"
  ami_description = "Servidor de tenant: Node, Nginx, PostgreSQL, app compilada y agentes"

  # Sin la etiqueta Proyecto=asistencia: Prometheus no debe vigilar el servidor temporal.
  run_tags = {
    Name = "packer-asistencia-tenant"
  }
  tags = {
    Name      = "asistencia-tenant-${local.fecha}"
    Imagen    = "asistencia-tenant"
    CreadaCon = "packer"
  }
}

build {
  sources = ["source.amazon-ebs.tenant"]

  provisioner "shell" {
    inline = ["mkdir -p /tmp/imagen/vars"]
  }

  # Las mismas tareas y variables de Ansible que usa tenant.yml (sin vault.yml: la imagen no lleva secretos).
  provisioner "file" {
    source      = "${path.root}/../ansible/tareas"
    destination = "/tmp/imagen/"
  }
  provisioner "file" {
    source      = "${path.root}/../ansible/group_vars/all/vars.yml"
    destination = "/tmp/imagen/vars/vars.yml"
  }
  provisioner "file" {
    source      = "${path.root}/../ansible/group_vars/all/monitoreo.yml"
    destination = "/tmp/imagen/vars/monitoreo.yml"
  }
  provisioner "file" {
    source      = "${path.root}/imagen.yml"
    destination = "/tmp/imagen/imagen.yml"
  }

  # Instala Ansible en el servidor temporal, ejecuta imagen.yml y limpia.
  provisioner "shell" {
    script          = "${path.root}/preparar.sh"
    execute_command = "chmod +x {{ .Path }}; sudo {{ .Path }}"
  }

  # Qué AMI salió en cada región (lo lee el LEEME y sirve de registro).
  post-processor "manifest" {
    output     = "${path.root}/../generado/imagen.json"
    strip_path = true
  }
}
