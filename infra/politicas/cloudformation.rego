# Políticas del equipo para el CHANGE SET de un tenant con CloudFormation.
#   aws cloudformation describe-change-set ... > cambios.json
#   conftest test cambios.json -p politicas --namespace cloudformation
# (El tipo de cada servidor lo valida la propia plantilla con AllowedValues.)
package cloudformation

import rego.v1

import data.comun

parametro(nombre) := valor if {
	some p in input.Parameters
	p.ParameterKey == nombre
	valor := p.ParameterValue
}

# 1. Solo planes con infraestructura definida.
deny contains msg if {
	not parametro("Plan") in comun.planes
	msg := sprintf("el plan %v no tiene infraestructura definida", [parametro("Plan")])
}

# 2. Crear o actualizar un tenant nunca borra ni reemplaza recursos.
deny contains msg if {
	some cambio in input.Changes
	cambio.ResourceChange.Action == "Remove"
	msg := sprintf("%s: el change set borra este recurso", [cambio.ResourceChange.LogicalResourceId])
}

deny contains msg if {
	some cambio in input.Changes
	cambio.ResourceChange.Replacement == "True"
	msg := sprintf("%s: el change set reemplaza este recurso (se perderían sus datos)", [cambio.ResourceChange.LogicalResourceId])
}

# 3. Las etiquetas que lee Prometheus van en el stack (CloudFormation las copia a cada recurso).
warn contains msg if {
	some etiqueta in {"Proyecto", "Tenant", "Plan"}
	not etiqueta_en_stack(etiqueta)
	msg := sprintf("al stack le falta la etiqueta %s (Prometheus no identificaría los servidores)", [etiqueta])
}

etiqueta_en_stack(etiqueta) if {
	some t in input.Tags
	t.Key == etiqueta
}
