# Salida común a todos los motores: el mismo JSON sale de Terraform, OpenTofu,
# Pulumi y CloudFormation. Con él se arma el inventario de Ansible:
#   ../../generado/tenants/<slug>.json  ->  python3 ../../scripts/inventario.py <slug>

locals {
  salida = {
    slug    = var.slug
    region  = var.region
    plan    = var.plan
    entorno = var.entorno
    motor   = var.motor
    numero  = var.numero
    cidr    = local.cidr
    dominio = local.dominio
    url     = "http://${local.dominio}"
    vpc_id  = aws_vpc.tenant.id
    peering = aws_vpc_peering_connection.plataforma.id
    imagen  = local.imagen
    servidores = {
      for rol, s in aws_instance.servidor : rol => {
        id      = s.id
        tipo    = s.instance_type
        privada = s.private_ip
        publica = s.public_ip
      }
    }
  }
}

resource "local_file" "salida" {
  filename        = "${path.module}/../../generado/tenants/${var.slug}.json"
  file_permission = "0644"
  content         = jsonencode(local.salida)
}

output "tenant" {
  description = "Datos del tenant (los mismos en todos los motores)."
  value       = local.salida
}
