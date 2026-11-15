# Políticas del equipo para el PLAN de un tenant con Terraform u OpenTofu.
# Las evalúa Conftest sobre "terraform show -json" antes de crear nada:
#   conftest test plan.json -p politicas --namespace terraform
#
#   deny  = detiene la creación del tenant
#   warn  = solo avisa (queda en el log)
package terraform

import rego.v1

import data.comun

# Servidores que se crean o se modifican (al cambiar de plan cambia el tipo).
instancias contains r if {
	some r in input.resource_changes
	r.type == "aws_instance"
	some accion in r.change.actions
	accion in {"create", "update"}
}

# Archivos locales que escribe el motor (generado/tenants/<slug>.json): se reemplazan cada
# vez que cambia su contenido, por ejemplo al cambiar de plan. No son recursos de la nube.
local(r) if startswith(r.type, "local_")

# 1. Solo tipos del plan gratuito de AWS.
deny contains msg if {
	some r in instancias
	not r.change.after.instance_type in comun.tipos_permitidos
	msg := sprintf("%s: el tipo %s no está permitido (plan gratuito de AWS)", [r.address, r.change.after.instance_type])
}

# 2. Crear un tenant o cambiar su plan nunca borra ni reemplaza recursos de la nube.
deny contains msg if {
	some r in input.resource_changes
	"delete" in r.change.actions
	not local(r)
	msg := sprintf("%s: el plan borra o reemplaza este recurso; al crear un tenant o cambiar su plan no se borra nada", [r.address])
}

# 3. Etiquetas que usa Prometheus para encontrar y etiquetar cada servidor.
warn contains msg if {
	some r in instancias
	some etiqueta in comun.etiquetas_requeridas
	not r.change.after.tags_all[etiqueta]
	msg := sprintf("%s: falta la etiqueta %s (Prometheus no lo identificaría)", [r.address, etiqueta])
}

# 4. Disco cifrado.
warn contains msg if {
	some r in instancias
	some disco in r.change.after.root_block_device
	disco.encrypted != true
	msg := sprintf("%s: el disco no está cifrado", [r.address])
}

# 5. IMDSv2 (los metadatos del servidor solo con token).
warn contains msg if {
	some r in instancias
	some opciones in r.change.after.metadata_options
	opciones.http_tokens != "required"
	msg := sprintf("%s: no exige IMDSv2", [r.address])
}

# 6. Nada abierto a internet: los tenants solo aceptan a la plataforma.
warn contains msg if {
	some r in input.resource_changes
	r.type == "aws_vpc_security_group_ingress_rule"
	r.change.after.cidr_ipv4 == "0.0.0.0/0"
	msg := sprintf("%s: puerto %v abierto a internet", [r.address, r.change.after.from_port])
}
