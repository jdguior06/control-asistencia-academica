# Red propia del tenant (10.N.0.0/16) y peering con la plataforma (10.0.0.0/16).
#
#   tenant ──peering──► plataforma   el gateway llega al frontend del tenant,
#                                    Prometheus a sus agentes y Ansible por SSH
#   tenant A ──✗──► tenant B         el peering no es transitivo: aislados entre sí

data "aws_availability_zones" "disponibles" {
  #checkov:skip=CKV_AWS_394:Solo se usa la primera zona; que AWS agregue zonas no cambia nada
  state = "available"
}

resource "aws_vpc" "tenant" {
  #checkov:skip=CKV2_AWS_11:Flow logs tienen costo; el tráfico se observa con Prometheus y Netdata
  #checkov:skip=CKV2_AWS_12:El grupo por defecto no se usa: cada servidor tiene su propio grupo
  cidr_block           = local.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.nombre}-vpc" }

  lifecycle {
    precondition {
      condition     = local.cidr != local.plataforma.cidr
      error_message = "La red del tenant no puede ser la misma que la de la plataforma."
    }
  }
}

# Salida a internet (instalar paquetes, git clone). Nadie entra desde internet:
# los firewalls solo aceptan a la plataforma (ver seguridad.tf).
resource "aws_internet_gateway" "tenant" {
  vpc_id = aws_vpc.tenant.id

  tags = { Name = "${local.nombre}-igw" }
}

resource "aws_subnet" "tenant" {
  #checkov:skip=CKV_AWS_130:IP pública solo para SALIR a internet (sin NAT, que cuesta); los firewalls no dejan entrar
  vpc_id                  = aws_vpc.tenant.id
  cidr_block              = local.subred
  availability_zone       = data.aws_availability_zones.disponibles.names[0]
  map_public_ip_on_launch = true

  tags = { Name = "${local.nombre}-subred" }
}

# ---------------------------------------------------------------- peering

# Lo pide el tenant (en su región)...
resource "aws_vpc_peering_connection" "plataforma" {
  vpc_id      = aws_vpc.tenant.id
  peer_vpc_id = local.plataforma.vpc_id
  peer_region = local.plataforma.region
  auto_accept = false

  tags = { Name = "${local.nombre}-a-plataforma" }
}

# ...y lo acepta la plataforma (en la región de la plataforma).
resource "aws_vpc_peering_connection_accepter" "plataforma" {
  provider = aws.plataforma

  vpc_peering_connection_id = aws_vpc_peering_connection.plataforma.id
  auto_accept               = true

  tags = { Name = "${local.nombre}-a-plataforma" }
}

# ---------------------------------------------------------------- rutas

resource "aws_route_table" "tenant" {
  #checkov:skip=CKV2_AWS_44:La salida 0.0.0.0/0 va al internet gateway; por el peering solo va 10.0.0.0/16
  vpc_id = aws_vpc.tenant.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.tenant.id
  }

  route {
    cidr_block                = local.plataforma.cidr
    vpc_peering_connection_id = aws_vpc_peering_connection.plataforma.id
  }

  tags = { Name = "${local.nombre}-rt" }

  depends_on = [aws_vpc_peering_connection_accepter.plataforma]
}

resource "aws_route_table_association" "tenant" {
  subnet_id      = aws_subnet.tenant.id
  route_table_id = aws_route_table.tenant.id
}

# Ruta de vuelta: en la tabla de la PLATAFORMA, 10.N.0.0/16 va por este peering.
resource "aws_route" "plataforma_a_tenant" {
  provider = aws.plataforma

  route_table_id            = local.plataforma.tabla_rutas
  destination_cidr_block    = local.cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.plataforma.id

  depends_on = [aws_vpc_peering_connection_accepter.plataforma]
}
