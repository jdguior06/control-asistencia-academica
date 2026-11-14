# Políticas del equipo para la VISTA PREVIA de un tenant con Pulumi.
#   pulumi preview --json > preview.json
#   conftest test preview.json -p politicas --namespace pulumi
package pulumi

import rego.v1

import data.comun

instancias contains paso if {
	some paso in input.steps
	paso.op == "create"
	paso.newState.type == "aws:ec2/instance:Instance"
}

# 1. Solo tipos del plan gratuito de AWS.
deny contains msg if {
	some paso in instancias
	tipo := paso.newState.inputs.instanceType
	not tipo in comun.tipos_permitidos
	msg := sprintf("%s: el tipo %s no está permitido (plan gratuito de AWS)", [paso.urn, tipo])
}

# 2. Crear un tenant nunca borra ni reemplaza nada.
deny contains msg if {
	some paso in input.steps
	paso.op in {"delete", "replace", "create-replacement", "delete-replaced"}
	msg := sprintf("%s: la vista previa borra o reemplaza este recurso (%s)", [paso.urn, paso.op])
}

# 3. Disco cifrado.
warn contains msg if {
	some paso in instancias
	paso.newState.inputs.rootBlockDevice.encrypted != true
	msg := sprintf("%s: el disco no está cifrado", [paso.urn])
}

# 4. IMDSv2.
warn contains msg if {
	some paso in instancias
	paso.newState.inputs.metadataOptions.httpTokens != "required"
	msg := sprintf("%s: no exige IMDSv2", [paso.urn])
}

# 5. Nada abierto a internet.
warn contains msg if {
	some paso in input.steps
	paso.newState.type == "aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule"
	paso.newState.inputs.cidrIpv4 == "0.0.0.0/0"
	msg := sprintf("%s: puerto %v abierto a internet", [paso.urn, paso.newState.inputs.fromPort])
}
