# Los 3 servidores del tenant. Se crean "vacíos" (solo con las claves SSH);
# los configura Ansible (../../ansible/tenant.yml).

data "aws_ssm_parameter" "amazon_linux" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "servidor" {
  for_each = toset(local.roles)

  ami                    = data.aws_ssm_parameter.amazon_linux.value
  instance_type          = local.tamanos[each.key].tipo
  subnet_id              = aws_subnet.tenant.id
  private_ip             = cidrhost(local.subred, local.ip_final[each.key])
  vpc_security_group_ids = [aws_security_group.servidor[each.key].id]

  user_data                   = local.user_data
  user_data_replace_on_change = true

  root_block_device {
    volume_size = local.tamanos[each.key].disco
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required" # IMDSv2
  }

  lifecycle {
    ignore_changes = [ami]
  }

  # Name y Rol también los lee Prometheus (etiquetas servidor y rol).
  tags = {
    Name = "${var.slug}-${each.key}"
    Rol  = each.key
  }
}
