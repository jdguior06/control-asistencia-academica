# Firewalls del tenant. Desde internet no entra nada: todo llega desde la
# plataforma (10.0.0.0/16) por el peering.
#
#   frontend  80 desde la plataforma (gateway)
#   backend   3000 solo desde el frontend
#   base      5432 solo desde el backend
#   los tres  22 (Ansible) y agentes de monitoreo desde la plataforma

locals {
  roles = ["frontend", "backend", "base"]

  # node_exporter, process-exporter, OpenTelemetry Collector y Netdata.
  puertos_agentes = [9100, 9256, 8889, 19999]

  # Una regla por cada combinación servidor × puerto (SSH + agentes).
  desde_plataforma = {
    for par in setproduct(local.roles, concat([22], local.puertos_agentes)) :
    "${par[0]}-${par[1]}" => { rol = par[0], puerto = par[1] }
  }
}

resource "aws_security_group" "servidor" {
  for_each = toset(local.roles)

  name        = "${local.nombre}-sg-${each.key}"
  description = "Tenant ${var.slug}: ${each.key}"
  vpc_id      = aws_vpc.tenant.id

  tags = { Name = "${local.nombre}-sg-${each.key}" }
}

resource "aws_vpc_security_group_ingress_rule" "desde_plataforma" {
  for_each = local.desde_plataforma

  security_group_id = aws_security_group.servidor[each.value.rol].id
  description       = each.value.puerto == 22 ? "SSH desde la plataforma (Ansible)" : "Monitoreo desde la plataforma"
  ip_protocol       = "tcp"
  from_port         = each.value.puerto
  to_port           = each.value.puerto
  cidr_ipv4         = local.plataforma.cidr
}

resource "aws_vpc_security_group_ingress_rule" "web_desde_gateway" {
  security_group_id = aws_security_group.servidor["frontend"].id
  description       = "Web desde el gateway de la plataforma"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = local.plataforma.cidr
}

resource "aws_vpc_security_group_ingress_rule" "api_desde_frontend" {
  security_group_id            = aws_security_group.servidor["backend"].id
  description                  = "API solo desde el frontend"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.servidor["frontend"].id
}

resource "aws_vpc_security_group_ingress_rule" "base_desde_backend" {
  security_group_id            = aws_security_group.servidor["base"].id
  description                  = "PostgreSQL solo desde el backend"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.servidor["backend"].id
}

resource "aws_vpc_security_group_egress_rule" "salida" {
  for_each = toset(local.roles)

  security_group_id = aws_security_group.servidor[each.key].id
  description       = "Salida a internet y a la plataforma"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
