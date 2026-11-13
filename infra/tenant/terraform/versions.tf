# Un tenant completo: su red, el peering con la plataforma y sus 3 servidores.
# Este mismo código sirve para Terraform y para OpenTofu.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  # Cada tenant tiene su propio estado. La clave se da al hacer init:
  #   terraform init -reconfigure -backend-config="key=tenants/<slug>/terraform.tfstate"
  backend "s3" {
    bucket       = "tfstate-asistencia-859142233691"
    region       = "us-east-2"
    use_lockfile = true
    encrypt      = true
  }
}

# Región del tenant (la que se elige en el formulario).
provider "aws" {
  region = var.region

  default_tags {
    tags = local.etiquetas
  }
}

# Región de la plataforma: para aceptar el peering y agregar la ruta de vuelta.
provider "aws" {
  alias  = "plataforma"
  region = local.plataforma.region

  default_tags {
    tags = local.etiquetas
  }
}
