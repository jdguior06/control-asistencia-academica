# Red de la plataforma: 10.0.0.0/16.
# Cada tenant tiene su propia red 10.N.0.0/16 y se conecta a esta por peering.
# El peering no es transitivo: un tenant llega a la plataforma, pero no a otro tenant.

locals {
  cidr_plataforma = "10.0.0.0/16"
}

data "aws_availability_zones" "disponibles" {
  state = "available"
}

resource "aws_vpc" "plataforma" {
  cidr_block           = local.cidr_plataforma
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.prefijo}-vpc" }
}

resource "aws_internet_gateway" "plataforma" {
  vpc_id = aws_vpc.plataforma.id

  tags = { Name = "${var.prefijo}-igw" }
}

resource "aws_subnet" "publica" {
  vpc_id                  = aws_vpc.plataforma.id
  cidr_block              = cidrsubnet(local.cidr_plataforma, 8, 1) # 10.0.1.0/24
  availability_zone       = data.aws_availability_zones.disponibles.names[0]
  map_public_ip_on_launch = true

  tags = { Name = "${var.prefijo}-subred-publica" }
}

# Tabla de rutas de la plataforma. Cada tenant le agrega su propia ruta
# (10.N.0.0/16 -> peering), por eso aquí la ruta a internet va en un recurso aparte.
resource "aws_route_table" "publica" {
  vpc_id = aws_vpc.plataforma.id

  tags = { Name = "${var.prefijo}-rt-publica" }

  lifecycle {
    # Las rutas a los tenants las administran los tenants, no la plataforma.
    ignore_changes = [route]
  }
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.publica.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.plataforma.id
}

resource "aws_route_table_association" "publica" {
  subnet_id      = aws_subnet.publica.id
  route_table_id = aws_route_table.publica.id
}
