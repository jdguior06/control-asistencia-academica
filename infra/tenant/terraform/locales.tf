# Valores calculados a partir de las entradas.

locals {
  plataforma = jsondecode(file(
    var.archivo_plataforma != "" ? var.archivo_plataforma : "${path.module}/../../generado/plataforma.json"
  ))

  nombre  = "tenant-${var.slug}"
  cidr    = "10.${var.numero}.0.0/16"
  subred  = cidrsubnet(local.cidr, 8, 1) # 10.N.1.0/24
  dominio = "${var.slug}.${local.plataforma.dominio}"

  # Prometheus lee estas etiquetas para saber de quién es cada servidor.
  etiquetas = {
    Proyecto      = "asistencia"
    Tenant        = var.slug
    Plan          = var.plan
    Entorno       = var.entorno
    Motor         = var.motor
    GestionadoPor = var.motor
  }

  # Tamaños por plan: la misma tabla que el portal (004_plan_instances.sql).
  planes = {
    basico = {
      frontend = { tipo = "t3.micro", disco = 32 }
      backend  = { tipo = "t3.medium", disco = 32 }
      base     = { tipo = "t3.medium", disco = 32 }
    }
    estandar = {
      frontend = { tipo = "t3.medium", disco = 32 }
      backend  = { tipo = "t3.large", disco = 32 }
      base     = { tipo = "t3.large", disco = 32 }
    }
    avanzado = {
      frontend = { tipo = "t3.large", disco = 32 }
      backend  = { tipo = "t3.xlarge", disco = 64 }
      base     = { tipo = "t3.xlarge", disco = 64 }
    }
  }
  tamanos = var.servidores != null ? var.servidores : local.planes[var.plan]

  # La misma IP final en todos los tenants: solo cambia el 10.N.
  ip_final = { backend = 10, frontend = 20, base = 30 }

  # cloud-init mínimo: solo las claves SSH. Todo lo demás lo hace Ansible.
  user_data = "#cloud-config\n${yamlencode({ ssh_authorized_keys = local.plataforma.claves_ssh })}"
}
