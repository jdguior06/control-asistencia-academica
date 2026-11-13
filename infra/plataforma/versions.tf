# Plataforma: la parte que existe una sola vez (portal, gateway y monitoreo).
# Los tenants se crean aparte (../tenant/) y se conectan a esta red por peering.

terraform {
  required_version = ">= 1.10" # use_lockfile en S3 requiere 1.10+

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }

    # Escribe ../generado/plataforma.json y el inventario de Ansible.
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  # El mismo bucket de las prácticas, en otra clave.
  backend "s3" {
    bucket       = "tfstate-asistencia-859142233691"
    key          = "proyecto/plataforma/terraform.tfstate"
    region       = "us-east-2"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region

  # Todas las cosas que crea la plataforma llevan estas etiquetas.
  # Prometheus busca los servidores por "Proyecto" (ver ansible/tareas/prometheus.yml).
  default_tags {
    tags = {
      Proyecto      = "asistencia"
      Tenant        = "plataforma"
      GestionadoPor = "terraform"
    }
  }
}
