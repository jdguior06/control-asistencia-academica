# Valores comunes a las políticas de los tres formatos (Terraform, Pulumi, CloudFormation).
package comun

import rego.v1

# Tipos que acepta el plan gratuito de AWS (los mismos que infra/tenant/terraform/locales.tf).
tipos_permitidos := {"t3.micro", "t3.small", "t8i.micro", "t8i.small", "c7i-flex.large", "m7i-flex.large"}

# Planes que tienen infraestructura definida.
planes := {"basico", "estandar", "avanzado"}

# Etiquetas que lee Prometheus (ansible/tareas/prometheus.yml).
etiquetas_requeridas := {"Proyecto", "Tenant", "Plan", "Rol"}
