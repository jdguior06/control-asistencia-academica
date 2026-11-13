# Lo que necesitan los demás: los tenants (cualquier motor) y Ansible.
#
#   ../generado/plataforma.json        datos de la red de la plataforma (lo leen los tenants)
#   ../ansible/inventarios/plataforma.ini
#
# Ninguno se sube a git: se vuelven a escribir con cada "terraform apply".

locals {
  dominio = "${aws_eip.plataforma.public_ip}.nip.io"

  plataforma = {
    region       = var.region
    cuenta       = data.aws_caller_identity.actual.account_id
    vpc_id       = aws_vpc.plataforma.id
    cidr         = aws_vpc.plataforma.cidr_block
    tabla_rutas  = aws_route_table.publica.id
    ip_publica   = aws_eip.plataforma.public_ip
    dominio      = local.dominio
    usuario_ssh  = "ec2-user"
    claves_ssh   = local.claves_ssh
    bucket       = var.bucket_estado
    regiones     = var.regiones_tenant
    ip_privadas  = { for nombre, s in aws_instance.servidor : nombre => s.private_ip }
    ip_monitoreo = aws_instance.servidor["monitoreo"].public_ip
  }
}

resource "local_file" "plataforma_json" {
  filename        = "${path.module}/../generado/plataforma.json"
  file_permission = "0644"
  content         = jsonencode(local.plataforma)
}

resource "local_file" "inventario_ansible" {
  filename        = "${path.module}/../ansible/inventarios/plataforma.ini"
  file_permission = "0644"

  content = <<-EOT
    # Generado por infra/plataforma (terraform apply). No editar.
    [plataforma]
    vm-plataforma ansible_host=${aws_eip.plataforma.public_ip} ip_privada=${aws_instance.servidor["plataforma"].private_ip}

    [monitoreo]
    vm-monitoreo ansible_host=${aws_instance.servidor["monitoreo"].public_ip} ip_privada=${aws_instance.servidor["monitoreo"].private_ip}

    [all:vars]
    ansible_user=ec2-user
    dominio=${local.dominio}
    ip_privada_monitoreo=${aws_instance.servidor["monitoreo"].private_ip}
    regiones_terraform=${join(",", var.regiones_tenant)}
  EOT

  depends_on = [aws_eip_association.plataforma]
}

output "portal" {
  description = "Dirección del portal."
  value       = "http://plataforma.${local.dominio}"
}

output "grafana" {
  description = "Grafana (a través del gateway y directo)."
  value = {
    gateway = "http://grafana.${local.dominio}"
    directo = "http://${aws_instance.servidor["monitoreo"].public_ip}:3000"
  }
}

output "dominio" {
  description = "Cada tenant queda en http://<slug>.<dominio>."
  value       = local.dominio
}

output "ssh" {
  description = "Para entrar a los servidores."
  value = {
    plataforma = "ssh ec2-user@${aws_eip.plataforma.public_ip}"
    monitoreo  = "ssh ec2-user@${aws_instance.servidor["monitoreo"].public_ip}"
  }
}
