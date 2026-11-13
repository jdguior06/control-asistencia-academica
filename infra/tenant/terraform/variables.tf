# Entradas del tenant. Son las MISMAS para todos los motores (Terraform, OpenTofu,
# Pulumi y CloudFormation): el portal las toma del formulario.

variable "slug" {
  description = "Identificador del tenant (va en la URL: <slug>.<ip>.nip.io)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", var.slug)) && length(var.slug) >= 3 && length(var.slug) <= 30
    error_message = "slug: 3 a 30 caracteres, minúsculas, números y guiones (ej. utepsa, la-salle)."
  }
}

variable "numero" {
  description = "Número de red del tenant: su red será 10.<numero>.0.0/16. Distinto para cada tenant (la plataforma usa el 0)."
  type        = number

  validation {
    condition     = var.numero >= 1 && var.numero <= 250 && floor(var.numero) == var.numero
    error_message = "numero debe ser un entero entre 1 y 250."
  }
}

variable "region" {
  description = "Región de AWS del tenant."
  type        = string
  default     = "us-east-2"

  validation {
    condition     = contains(["us-east-1", "us-east-2", "us-west-2"], var.region)
    error_message = "region debe ser us-east-1, us-east-2 o us-west-2."
  }
}

variable "plan" {
  description = "Plan contratado: define el tamaño de los servidores."
  type        = string
  default     = "basico"

  validation {
    condition     = contains(["basico", "estandar", "avanzado"], var.plan)
    error_message = "plan debe ser basico, estandar o avanzado."
  }
}

variable "entorno" {
  description = "Entorno del tenant."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["production", "staging"], var.entorno)
    error_message = "entorno debe ser production o staging."
  }
}

variable "motor" {
  description = "Herramienta que creó el tenant (queda como etiqueta). Con OpenTofu: -var motor=opentofu."
  type        = string
  default     = "terraform"

  validation {
    condition     = contains(["terraform", "opentofu"], var.motor)
    error_message = "motor debe ser terraform u opentofu."
  }
}

variable "servidores" {
  description = "Opcional: otro tamaño de servidores en vez del del plan. Ej. { frontend = { tipo = \"t3.micro\", disco = 16 }, ... }"
  type = map(object({
    tipo  = string
    disco = number
  }))
  default = null
}

variable "archivo_plataforma" {
  description = "Datos de la plataforma (los escribe infra/plataforma). Vacío = ../../generado/plataforma.json."
  type        = string
  default     = ""
}
