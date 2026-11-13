# Firewalls (security groups) de la plataforma.
#
#   plataforma  80 y 443 desde internet (portal y gateway de los tenants), 22 para Ansible
#   monitoreo   3000 (Grafana) y 9090 (Prometheus) para ver los paneles, 22 para Ansible
#
# Las métricas de los tenants llegan por el peering: el firewall de cada TENANT
# deja entrar a la red 10.0.0.0/16 (ver ../tenant/terraform/seguridad.tf).

resource "aws_security_group" "plataforma" {
  name        = "${var.prefijo}-sg-plataforma"
  description = "Portal y gateway de los tenants"
  vpc_id      = aws_vpc.plataforma.id

  tags = { Name = "${var.prefijo}-sg-plataforma" }
}

resource "aws_security_group" "monitoreo" {
  name        = "${var.prefijo}-sg-monitoreo"
  description = "Prometheus y Grafana"
  vpc_id      = aws_vpc.plataforma.id

  tags = { Name = "${var.prefijo}-sg-monitoreo" }
}

# ---------------------------------------------------------------- plataforma

resource "aws_vpc_security_group_ingress_rule" "plataforma_web" {
  for_each = toset(["80", "443"])

  security_group_id = aws_security_group.plataforma.id
  description       = "Portal y tenants (nip.io)"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "plataforma_ssh" {
  security_group_id = aws_security_group.plataforma.id
  description       = "SSH (Ansible y salto hacia los tenants)"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = var.ssh_permitido
}

resource "aws_vpc_security_group_ingress_rule" "plataforma_metricas" {
  security_group_id            = aws_security_group.plataforma.id
  description                  = "node_exporter, solo desde monitoreo"
  ip_protocol                  = "tcp"
  from_port                    = 9100
  to_port                      = 9100
  referenced_security_group_id = aws_security_group.monitoreo.id
}

# ---------------------------------------------------------------- monitoreo

resource "aws_vpc_security_group_ingress_rule" "monitoreo_paneles" {
  for_each = toset(["3000", "9090"])

  security_group_id = aws_security_group.monitoreo.id
  description       = "Grafana y Prometheus"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = var.acceso_paneles
}

resource "aws_vpc_security_group_ingress_rule" "monitoreo_desde_gateway" {
  security_group_id            = aws_security_group.monitoreo.id
  description                  = "Grafana a traves del gateway (grafana.<ip>.nip.io)"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.plataforma.id
}

resource "aws_vpc_security_group_ingress_rule" "monitoreo_ssh" {
  security_group_id = aws_security_group.monitoreo.id
  description       = "SSH (Ansible)"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = var.ssh_permitido
}

# ---------------------------------------------------------------- salida a internet (los dos)

resource "aws_vpc_security_group_egress_rule" "salida" {
  for_each = {
    plataforma = aws_security_group.plataforma.id
    monitoreo  = aws_security_group.monitoreo.id
  }

  security_group_id = each.value
  description       = "Salida a internet y a los tenants"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
