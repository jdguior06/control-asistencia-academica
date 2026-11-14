# Valores configurables de la plataforma.

variable "region" {
  description = "Región de la plataforma. Los tenants pueden estar en esta u otras regiones."
  type        = string
  default     = "us-east-2"
}

variable "prefijo" {
  description = "Prefijo de los nombres (distinto al de las prácticas)."
  type        = string
  default     = "asistencia-plataforma"
}

variable "regiones_tenant" {
  description = "Regiones donde se pueden crear tenants. Prometheus busca servidores en todas ellas."
  type        = list(string)
  # Las 3 regiones que permite la organización de la cuenta (SCP de la cuenta administradora).
  default = ["us-east-2", "us-east-1", "us-west-2"]
}

variable "tipo_plataforma" {
  description = "Servidor del portal y el gateway. Compila el portal: 2 GB de RAM como mínimo."
  type        = string
  default     = "t3.small"
}

variable "disco_plataforma_gb" {
  description = "Disco del servidor del portal en GB (código, base del portal y herramientas de IaC)."
  type        = number
  default     = 20
}

variable "tipo_monitoreo" {
  description = "Servidor de Prometheus y Grafana: 2 GB de RAM como mínimo."
  type        = string
  default     = "t3.small"
}

variable "disco_monitoreo_gb" {
  description = "Disco del servidor de monitoreo en GB (aquí Prometheus guarda las métricas)."
  type        = number
  default     = 20
}

variable "ssh_permitido" {
  description = "Desde dónde se permite SSH a la plataforma. Para restringirlo usa tu IP con /32."
  type        = string
  default     = "0.0.0.0/0"

  validation {
    condition     = can(cidrhost(var.ssh_permitido, 0))
    error_message = "ssh_permitido debe estar en formato CIDR, por ejemplo 0.0.0.0/0 o 190.10.20.30/32."
  }
}

variable "acceso_paneles" {
  description = "Desde dónde se permite abrir Grafana (3000) y Prometheus (9090) directamente."
  type        = string
  default     = "0.0.0.0/0"

  validation {
    condition     = can(cidrhost(var.acceso_paneles, 0))
    error_message = "acceso_paneles debe estar en formato CIDR, por ejemplo 0.0.0.0/0 o 190.10.20.30/32."
  }
}

variable "bucket_estado" {
  description = "Bucket de los estados de Terraform/OpenTofu y Pulumi. El portal lo usa para crear tenants."
  type        = string
  default     = "tfstate-asistencia-859142233691"
}
