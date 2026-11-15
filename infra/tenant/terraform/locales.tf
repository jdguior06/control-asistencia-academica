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

  # Tamaños por plan: la misma tabla que el portal (migración 005_planes_free_tier.sql).
  # La cuenta está en el plan gratuito de AWS: solo admite los tipos de tipos_permitidos.
  # Todos tienen 2 vCPU; los planes se distinguen por la memoria y el disco.
  planes = {
    basico = {
      frontend = { tipo = "t3.micro", disco = 20 } # 1 GB
      backend  = { tipo = "t3.small", disco = 20 } # 2 GB
      base     = { tipo = "t3.small", disco = 20 } # 2 GB
    }
    estandar = {
      frontend = { tipo = "t3.small", disco = 30 }       # 2 GB
      backend  = { tipo = "c7i-flex.large", disco = 30 } # 4 GB
      base     = { tipo = "c7i-flex.large", disco = 30 } # 4 GB
    }
    avanzado = {
      frontend = { tipo = "t3.small", disco = 40 }       # 2 GB
      backend  = { tipo = "m7i-flex.large", disco = 40 } # 8 GB
      base     = { tipo = "m7i-flex.large", disco = 40 } # 8 GB
    }
  }

  # Tipos que acepta el plan gratuito de AWS (describe-instance-types --filters
  # Name=free-tier-eligible,Values=true). Los t4g son ARM: no sirven con esta AMI x86_64.
  tipos_permitidos = ["t3.micro", "t3.small", "t8i.micro", "t8i.small", "c7i-flex.large", "m7i-flex.large"]

  tamanos = var.servidores != null ? var.servidores : {
    for rol, t in local.planes[var.plan] : rol => { tipo = t.tipo, disco = var.disco > 0 ? var.disco : t.disco }
  }

  # La misma IP final en todos los tenants: solo cambia el 10.N.
  ip_final = { backend = 10, frontend = 20, base = 30 }

  # cloud-init mínimo: solo las claves SSH. Todo lo demás lo hace Ansible.
  user_data = "#cloud-config\n${yamlencode({ ssh_authorized_keys = local.plataforma.claves_ssh })}"
}
