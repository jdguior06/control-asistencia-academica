#!/usr/bin/env bash
# Crea o borra UN tenant completo, con cualquiera de los 4 motores. Lo ejecuta el
# worker del portal en vm-plataforma, y también se puede ejecutar a mano allí:
#
#   sudo -iu iac
#   cd /opt/iac/repo/infra
#   bash scripts/aprovisionar.sh crear  --slug utepsa --motor terraform --region us-east-2 --plan basico --numero 1
#   bash scripts/aprovisionar.sh borrar --slug utepsa --motor terraform --region us-east-2 --plan basico --numero 1
#   bash scripts/aprovisionar.sh suspender|reanudar --slug utepsa --motor terraform --region us-east-2 --plan basico --numero 1
#   bash scripts/aprovisionar.sh respaldar --slug utepsa --motor terraform --region us-east-2 --plan basico --numero 1
#   bash scripts/aprovisionar.sh restaurar --slug utepsa ... --respaldo tenants/utepsa/20261115-030000.dump
#   bash scripts/aprovisionar.sh actualizar --slug utepsa ... [--respaldar-antes si] [--parches si]
#     (RF-15: el mismo flujo de crear sobre un tenant que ya existe: plantillas y app nuevas)
#
# Pasos al crear:
#   1 Validar   2 Escaneo de seguridad del código   3 Plan y políticas (Conftest, Infracost)
#   4 Crear la infraestructura   5 Configurar con Ansible   6 Verificar
#
# Cada paso imprime marcas que el portal convierte en la lista de pasos:
#   ::paso::N::Título   ::ok::N::resumen   ::aviso::N::resumen   ::error::N::motivo
#   ::resultado::{json}  (al final)
#   ::versiones::{json}  versiones de la app, las plantillas y las herramientas (RF-13)
# Las advertencias de los escáneres NO detienen la creación; sí la detienen un
# secreto encontrado por Gitleaks o una regla "deny" de las políticas (politicas/).
set -Eeuo pipefail

INFRA=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# ------------------------------------------------------------------ marcas
PASO=0
paso()   { PASO=$1; echo "::paso::$1::$2"; }
siguiente() { paso $(( PASO + 1 )) "$1"; }
ok()     { echo "::ok::$PASO::$*"; }
aviso()  { echo "::aviso::$PASO::$*"; }
fallar() { echo "::error::$PASO::$*"; exit 1; }
titulo() { echo; echo "──── $* ────"; }
trap 'echo "::error::$PASO::Falló: ${BASH_COMMAND:0:160}"' ERR

# ------------------------------------------------------------------ entradas
uso() { echo "Uso: $0 crear|actualizar|borrar|suspender|reanudar|respaldar|restaurar --slug S --motor M --region R --plan P [--entorno E] --numero N [--respaldo CLAVE]"; exit 2; }
accion=${1:-}; [[ $# -gt 0 ]] && shift
slug=""; motor=""; region="us-east-2"; plan="basico"; entorno="production"; numero=0; respaldo=""; disco=0; conservar_desde=""; respaldar_antes=no; parches=no
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || uso
  case $1 in
    --slug) slug=$2 ;; --motor) motor=$2 ;; --region) region=$2 ;;
    --plan) plan=$2 ;; --entorno) entorno=$2 ;; --numero) numero=$2 ;; --respaldo) respaldo=$2 ;;
    --disco) disco=$2 ;; --conservar-desde) conservar_desde=$2 ;;
    --respaldar-antes) respaldar_antes=$2 ;; --parches) parches=$2 ;;
    *) uso ;;
  esac
  shift 2
done

GEN="$INFRA/generado/tenants/$slug"
case $motor in
  terraform)      DIR="$INFRA/tenant/terraform"; TF=terraform ;;
  opentofu)       DIR="$INFRA/tenant/terraform"; TF=tofu ;;
  pulumi)         DIR="$INFRA/tenant/pulumi" ;;
  cloudformation) DIR="$INFRA/tenant/cloudformation" ;;
esac

# Lee un valor de un JSON: json archivo.json clave.subclave
json() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8-sig"))
for k in sys.argv[2].split("."): d=d[k]
print(d if not isinstance(d,(list,dict)) else json.dumps(d))' "$1" "$2"; }

# ==================================================================== 1. validar
paso 1 "Validar datos"
[[ $accion =~ ^(crear|actualizar|borrar|suspender|reanudar|respaldar|restaurar)$ ]] || fallar "acción '$accion' (crear, actualizar, borrar, suspender, reanudar, respaldar o restaurar)"
# Actualizar (RF-15) es crear sobre lo que ya existe: los motores solo cambian lo que cambió
# en las plantillas y Ansible lleva la app al último commit.
actualizar=0
if [[ $accion == actualizar ]]; then
  actualizar=1
  accion=crear
fi
[[ $slug =~ ^[a-z0-9]+(-[a-z0-9]+)*$ && ${#slug} -ge 3 && ${#slug} -le 30 ]] || fallar "slug '$slug' no válido (3 a 30: minúsculas, números y guiones)"
(( actualizar )) && { [[ -f $INFRA/generado/tenants/$slug.json ]] || fallar "el tenant no tiene infraestructura: créala primero"; }
[[ $respaldar_antes =~ ^(si|no)$ && $parches =~ ^(si|no)$ ]] || fallar "--respaldar-antes y --parches: si o no"
[[ $motor =~ ^(terraform|opentofu|pulumi|cloudformation)$ ]] || fallar "motor '$motor' no válido"
[[ $region =~ ^(us-east-1|us-east-2|us-west-2)$ ]] || fallar "región '$region' no disponible (us-east-1, us-east-2, us-west-2)"
[[ $plan =~ ^(basico|estandar|avanzado)$ ]] || fallar "plan '$plan' sin infraestructura definida"
[[ $entorno =~ ^(production|staging)$ ]] || fallar "entorno '$entorno' no válido"
[[ $numero =~ ^[0-9]+$ && $numero -ge 1 && $numero -le 250 ]] || fallar "número de red '$numero' (1 a 250)"
[[ $disco =~ ^[0-9]+$ && ( $disco -eq 0 || ( $disco -ge 8 && $disco -le 200 ) ) ]] || fallar "disco '$disco' (0 = el del plan, o 8 a 200 GB)"
PLATAFORMA="$INFRA/generado/plataforma.json"
[[ -f $PLATAFORMA ]] || fallar "falta generado/plataforma.json (lo copia plataforma.yml)"
DOMINIO=$(json "$PLATAFORMA" dominio)
REGION_PLAT=$(json "$PLATAFORMA" region)

necesarias=(python3 aws)
[[ $accion =~ ^(respaldar|restaurar)$ ]] && necesarias+=(ansible)
case $motor in
  terraform|opentofu) necesarias+=("$TF") ;;
  pulumi) necesarias+=(pulumi node npm) ;;
esac
[[ $accion == crear ]] && necesarias+=(ansible-playbook checkov trivy gitleaks conftest)
[[ $accion == crear && $motor =~ ^(terraform|opentofu)$ ]] && necesarias+=(tflint)
[[ $accion == crear && $motor == cloudformation ]] && necesarias+=(cfn-lint)
for herramienta in "${necesarias[@]}"; do
  command -v "$herramienta" >/dev/null || fallar "falta la herramienta $herramienta en el servidor"
done
mkdir -p "$GEN"
echo "Tenant $slug · motor $motor · región $region · plan $plan · red 10.$numero.0.0/16 · $slug.$DOMINIO"
ok "$slug · 10.$numero.0.0/16 · $plan · $region · $motor"

# ------------------------------------------------------------------ versiones (RF-13)
# Qué código, qué plantilla y qué herramientas usa este trabajo. El worker las guarda con
# el trabajo y se ven en el portal (Infraestructura → Versiones) y en la auditoría.
REPO=$(cd "$INFRA/.." && pwd)
commit_de() { git -C "$REPO" log -1 --format=%h -- "$@" 2>/dev/null || true; }
version_de() { "$@" 2>&1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true; }
versiones() { # versiones clave=valor ... → ::versiones::{"clave": "valor"} (sin valores vacíos)
  python3 -c 'import json,sys
d={}
for par in sys.argv[1:]:
    k,_,v=par.partition("=")
    if v.strip(): d[k]=v.strip()
print("::versiones::"+json.dumps(d, ensure_ascii=False))' "$@"
}
case $motor in
  terraform)      motor_version=$(version_de terraform version) ;;
  opentofu)       motor_version=$(version_de tofu version) ;;
  pulumi)         motor_version=$(version_de pulumi version) ;;
  cloudformation) motor_version=$(version_de aws --version) ;;
esac
proveedor=""
if [[ $motor =~ ^(terraform|opentofu)$ && -f $DIR/.terraform.lock.hcl ]]; then
  proveedor=$(grep -A1 'hashicorp/aws"' "$DIR/.terraform.lock.hcl" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
elif [[ $motor == pulumi && -f $DIR/package-lock.json ]]; then
  proveedor=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"]["node_modules/@pulumi/aws"]["version"])' "$DIR/package-lock.json" 2>/dev/null || true)
fi
plantilla_hash=$(cat "$DIR"/*.tf "$DIR"/*.ts "$DIR"/*.yaml 2>/dev/null | sha256sum | cut -c1-12 || true)
herramientas=(
  "repo_commit=$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || true)"
  "repo_rama=$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  "repo_fecha=$(git -C "$REPO" log -1 --format=%cI 2>/dev/null || true)"
  "app_commit=$(commit_de admin-docente-alumno)"
  "app_version=$(json "$REPO/admin-docente-alumno/server/package.json" version 2>/dev/null || true)"
  "plantilla=${DIR#"$REPO"/}"
  "plantilla_commit=$(commit_de "$DIR")"
  "plantilla_hash=$plantilla_hash"
  "ansible_commit=$(commit_de infra/ansible)"
  "motor=$motor"
  "motor_version=$motor_version"
  "proveedor_aws=$proveedor"
  "aws_cli=$(version_de aws --version)"
)
if [[ $accion == crear ]]; then
  herramientas+=(
    "ansible=$(version_de ansible --version)"
    "checkov=$(version_de checkov --version)"
    "trivy=$(version_de trivy --version)"
    "gitleaks=$(version_de gitleaks version)"
    "conftest=$(version_de conftest --version)"
  )
  [[ $motor =~ ^(terraform|opentofu)$ ]] && herramientas+=("tflint=$(version_de tflint --version)")
  [[ $motor == cloudformation ]] && herramientas+=("cfn_lint=$(version_de cfn-lint --version)")
fi
versiones "${herramientas[@]}"

# ==================================================================== suspender / reanudar
# Igual para los 4 motores: se apagan o encienden los servidores con la etiqueta del
# tenant. Apagados no consumen vCPU ni horas de cómputo; los discos (y los datos) quedan.
servidores_en() { # servidores_en running,pending
  aws ec2 describe-instances --region "$region" \
    --filters "Name=tag:Proyecto,Values=asistencia" "Name=tag:Tenant,Values=$slug" "Name=instance-state-name,Values=$1" \
    --query 'Reservations[].Instances[].InstanceId' --output text
}

if [[ $accion == suspender ]]; then
  paso 2 "Apagar los servidores"
  ids=$(servidores_en running,pending)
  if [[ -z $ids ]]; then
    ok "ya estaban apagados"
  else
    echo "Apagando: $ids"
    aws ec2 stop-instances --region "$region" --instance-ids $ids --output text >/dev/null
    aws ec2 wait instance-stopped --region "$region" --instance-ids $ids
    ok "$(wc -w <<<"$ids") servidores apagados · los datos se conservan"
  fi
  echo "Prometheus deja de vigilarlos (solo busca servidores encendidos) y el gateway responde 502."
  echo '::resultado::{"suspendido":true}'
  exit 0
fi

if [[ $accion == reanudar ]]; then
  paso 2 "Encender los servidores"
  ids=$(servidores_en stopped,stopping)
  if [[ -z $ids ]]; then
    ok "ya estaban encendidos"
  else
    echo "Encendiendo: $ids"
    aws ec2 start-instances --region "$region" --instance-ids $ids --output text >/dev/null
    aws ec2 wait instance-running --region "$region" --instance-ids $ids
    ok "$(wc -w <<<"$ids") servidores encendidos (misma IP privada; los servicios arrancan solos)"
  fi

  paso 3 "Verificar"
  url="http://$slug.$DOMINIO"
  for intento in $(seq 1 30); do
    codigo=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Host: $slug.$DOMINIO" http://127.0.0.1/api/health || true)
    [[ $codigo == 200 ]] && break
    echo "Intento $intento: $url/api/health → $codigo (esperando a que arranquen los servicios)"
    sleep 10
  done
  [[ $codigo == 200 ]] || fallar "$url/api/health respondió $codigo después de 5 minutos"
  ok "$url responde"
  python3 -c 'import json,sys; print("::resultado::"+json.dumps({"url":sys.argv[1]}))' "$url"
  exit 0
fi

# ==================================================================== respaldar / restaurar (RF-19)
# El worker entra por SSH a la base del tenant (como en tenant.yml), hace pg_dump y guarda el
# archivo en el bucket de respaldos de la plataforma: s3://<bucket>/tenants/<slug>/<fecha>.dump
# Respaldo de la base (lo usan "respaldar" y "actualizar" con --respaldar-antes).
DB=asistencia
preparar_respaldos() {
  BUCKET=$(json "$PLATAFORMA" respaldos 2>/dev/null || true)
  [[ -n $BUCKET ]] || fallar "falta el bucket de respaldos (terraform apply en infra/plataforma y luego plataforma.yml)"
  [[ -f $INFRA/generado/tenants/$slug.json ]] || fallar "el tenant no tiene infraestructura creada"
  encendidos=$(servidores_en running | wc -w)
  (( encendidos == 3 )) || fallar "los servidores no están encendidos ($encendidos de 3): reanuda el tenant primero"
  cd "$INFRA"
  python3 scripts/inventario.py "$slug" --en-plataforma >/dev/null
  cd "$INFRA/ansible"
  inv=(-i "inventarios/$slug.ini" -o)
  mkdir -p "$GEN/respaldos"
}

respaldo_copiar() { # deja el archivo en $archivo y su tamaño en $bytes
  fecha=$(date -u +%Y%m%d-%H%M%S)
  remoto="/tmp/respaldo-$slug.dump"
  archivo="$GEN/respaldos/$fecha.dump"
  ansible "$slug-base" "${inv[@]}" -b --become-user postgres -m shell -a "pg_dump -Fc -d $DB -f $remoto"
  ansible "$slug-base" "${inv[@]}" -b -m fetch -a "src=$remoto dest=$archivo flat=yes" >/dev/null
  ansible "$slug-base" "${inv[@]}" -b -m file -a "path=$remoto state=absent" >/dev/null
  bytes=$(stat -c %s "$archivo")
}

respaldo_guardar() { # sube $archivo a S3 ($clave) y aplica la retención del plan ($eliminados)
  clave="tenants/$slug/$fecha.dump"
  aws s3 cp "$archivo" "s3://$BUCKET/$clave" --only-show-errors
  rm -f "$archivo"
  case $plan in basico) conservar=4 ;; estandar) conservar=7 ;; *) conservar=30 ;; esac
  todas=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "tenants/$slug/" --query 'Contents[].Key' --output text | tr '\t' '\n' | grep -E '\.dump$' | sort || true)
  # Los respaldos de antes de la infraestructura actual (antes de eliminarla y volver a
  # crearla) no cuentan para la retención: solo caducan a los 90 días.
  if [[ $conservar_desde =~ ^[0-9]{8}-[0-9]{6}$ ]]; then
    todas=$(while read -r k; do [[ -n $k && $(basename "$k" .dump) > "$conservar_desde" ]] && echo "$k"; done <<<"$todas" || true)
  fi
  total=$(grep -c . <<<"$todas" || true)
  eliminados=()
  if (( total > conservar )); then
    while read -r vieja; do
      aws s3 rm "s3://$BUCKET/$vieja" --only-show-errors
      eliminados+=("$vieja")
    done < <(head -n $(( total - conservar )) <<<"$todas")
  fi
  echo "Respaldos de $slug en S3: $(( total - ${#eliminados[@]} )) (plan $plan: se conservan los últimos $conservar)"
}

respaldo_json() { # ::resultado:: del respaldo (clave, tamaño y los que se borraron)
  python3 -c 'import json,sys; print(json.dumps({"respaldo":{"clave":sys.argv[1],"bytes":int(sys.argv[2]),"bucket":sys.argv[3]},"eliminados":sys.argv[4:]}))' \
    "$clave" "$bytes" "$BUCKET" "${eliminados[@]}"
}

if [[ $accion == respaldar || $accion == restaurar ]]; then
  preparar_respaldos

  if [[ $accion == respaldar ]]; then
    paso 2 "Copiar la base de datos (pg_dump)"
    respaldo_copiar
    ok "base $DB · $(numfmt --to=iec "$bytes")B"
    paso 3 "Guardar en S3 y aplicar la retención del plan"
    respaldo_guardar
    ok "s3://$BUCKET/$clave${eliminados:+ · ${#eliminados[@]} antiguo(s) eliminado(s)}"
    echo "::resultado::$(respaldo_json)"
    exit 0
  fi

  # Restaurar: la copia se carga en una base nueva; recién si termina bien se detiene la API
  # un momento y se intercambian los nombres. Si algo falla antes, la base actual no se toca.
  [[ $respaldo =~ ^tenants/[a-z0-9-]+/[0-9]{8}-[0-9]{6}\.dump$ ]] || fallar "respaldo '$respaldo' no válido"
  paso 2 "Descargar el respaldo"
  archivo="$GEN/respaldos/restaurar.dump"
  aws s3 cp "s3://$BUCKET/$respaldo" "$archivo" --only-show-errors
  ok "$respaldo · $(numfmt --to=iec "$(stat -c %s "$archivo")")B"

  paso 3 "Cargar la copia en una base nueva"
  ansible "$slug-base" "${inv[@]}" -b -m copy -a "src=$archivo dest=/tmp/restaurar.dump mode=0644" >/dev/null
  rm -f "$archivo"
  ansible "$slug-base" "${inv[@]}" -b --become-user postgres -m shell -a \
    "dropdb --if-exists ${DB}_restaurando && createdb -O $DB ${DB}_restaurando && pg_restore --no-owner --role=$DB --exit-on-error -d ${DB}_restaurando /tmp/restaurar.dump"
  ok "la copia se cargó en ${DB}_restaurando (la base actual sigue intacta)"

  paso 4 "Reemplazar la base (la API se detiene unos segundos)"
  ansible "$slug-backend" "${inv[@]}" -b -m systemd -a "name=asistencia-api state=stopped" >/dev/null
  cambio=0
  ansible "$slug-base" "${inv[@]}" -b --become-user postgres -m shell -a \
    "psql -X -v ON_ERROR_STOP=1 -c 'ALTER DATABASE $DB ALLOW_CONNECTIONS false' -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()\" && dropdb --if-exists ${DB}_anterior && psql -X -v ON_ERROR_STOP=1 -c 'ALTER DATABASE $DB RENAME TO ${DB}_anterior' -c 'ALTER DATABASE ${DB}_restaurando RENAME TO $DB'" \
    || cambio=$?
  ansible "$slug-backend" "${inv[@]}" -b -m systemd -a "name=asistencia-api state=started" >/dev/null
  ansible "$slug-base" "${inv[@]}" -b -m file -a "path=/tmp/restaurar.dump state=absent" >/dev/null
  (( cambio == 0 )) || fallar "no se pudo reemplazar la base (la API volvió a arrancar con la base anterior)"
  ok "base restaurada; la anterior quedó como ${DB}_anterior hasta verificar"

  paso 5 "Verificar"
  url="http://$slug.$DOMINIO"
  codigo=000
  for intento in $(seq 1 18); do
    codigo=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Host: $slug.$DOMINIO" http://127.0.0.1/api/health || true)
    [[ $codigo == 200 ]] && break
    echo "Intento $intento: $url/api/health → $codigo"
    sleep 5
  done
  [[ $codigo == 200 ]] || fallar "$url/api/health respondió $codigo: la base anterior sigue guardada como ${DB}_anterior"
  ansible "$slug-base" "${inv[@]}" -b --become-user postgres -m shell -a "dropdb --if-exists ${DB}_anterior" >/dev/null
  ok "$url responde con los datos del respaldo"
  python3 -c 'import json,sys; print("::resultado::"+json.dumps({"restaurado":sys.argv[1],"url":sys.argv[2]}))' "$respaldo" "$url"
  exit 0
fi

# ==================================================================== borrar
if [[ $accion == borrar ]]; then
  paso 2 "Destruir la infraestructura ($motor)"
  case $motor in
    terraform|opentofu)
      cd "$DIR"
      printf '{"slug":"%s","numero":%s,"region":"%s","plan":"%s","entorno":"%s","motor":"%s"}\n' \
        "$slug" "$numero" "$region" "$plan" "$entorno" "$motor" > "$GEN/entrada.tfvars.json"
      $TF init -input=false -reconfigure -backend-config="key=tenants/$slug/terraform.tfstate" -no-color >/dev/null
      $TF destroy -input=false -auto-approve -no-color -var-file="$GEN/entrada.tfvars.json"
      ;;
    pulumi)
      cd "$DIR"
      if pulumi stack select "$slug" --non-interactive 2>/dev/null; then
        pulumi destroy --yes --non-interactive --skip-preview --color never
        pulumi stack rm "$slug" --yes --non-interactive
      else
        echo "El stack $slug no existe: nada que destruir."
      fi
      ;;
    cloudformation)
      for par in "$REGION_PLAT:tenant-$slug-ruta" "$region:tenant-$slug"; do
        reg=${par%%:*}; stack=${par#*:}
        echo "Borrando el stack $stack en $reg…"
        aws cloudformation delete-stack --region "$reg" --stack-name "$stack"
        aws cloudformation wait stack-delete-complete --region "$reg" --stack-name "$stack"
      done
      ;;
  esac
  ok "red, peering y servidores borrados"

  paso 3 "Quitar la ruta del gateway"
  if [[ -f /etc/nginx/tenants/$slug.conf ]]; then
    sudo rm -f "/etc/nginx/tenants/$slug.conf"
    sudo nginx -t && sudo systemctl reload nginx
    ok "$slug.$DOMINIO ya no responde"
  else
    ok "no tenía ruta"
  fi
  echo "Prometheus deja de verlo solo (busca servidores encendidos con la etiqueta Proyecto)."

  paso 4 "Archivar los datos generados"
  archivo="$INFRA/generado/borrados/$slug-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$(dirname "$archivo")"
  [[ -d $GEN ]] && mv "$GEN" "$archivo"
  rm -f "$INFRA/generado/tenants/$slug.json" "$INFRA/ansible/inventarios/$slug.ini"
  ok "contraseñas y reportes en generado/borrados/"
  echo '::resultado::{"borrado":true}'
  exit 0
fi

# ==================================================================== actualizar: respaldo previo
respaldo_previo=""
if (( actualizar )) && [[ $respaldar_antes == si ]]; then
  siguiente "Respaldo previo de la base de datos"
  pushd . >/dev/null # preparar_respaldos cambia de carpeta
  preparar_respaldos
  respaldo_copiar
  respaldo_guardar
  popd >/dev/null
  respaldo_previo=$(respaldo_json)
  ok "s3://$BUCKET/$clave · $(numfmt --to=iec "$bytes")B (se puede restaurar si la actualización sale mal)"
fi

# ==================================================================== 2. escaneo
siguiente "Escaneo de seguridad del código"
resumen=()
advertencias=0

# Resumen de Checkov en JSON: aprobadas, fallidas, omitidas (aceptadas por diseño).
checkov_resumen() { python3 - "$1" <<'PY'
import json, sys
datos = json.load(open(sys.argv[1]))
datos = datos if isinstance(datos, list) else [datos]
ok = mal = omit = 0
for d in datos:
    r = d.get("summary", {})
    ok += r.get("passed", 0); mal += r.get("failed", 0); omit += r.get("skipped", 0)
    for c in d.get("results", {}).get("failed_checks", []):
        print(f"  FALLA {c['check_id']}  {c['resource']}  ({c['check_name']})")
print(f"RESUMEN {ok} {mal} {omit}")
PY
}

# Resumen de Trivy en JSON por severidad (imprime los HIGH y CRITICAL).
trivy_resumen() { python3 - "$1" <<'PY'
import json, sys, collections
datos = json.load(open(sys.argv[1]))
cuenta = collections.Counter()
for r in datos.get("Results") or []:
    for m in (r.get("Misconfigurations") or []) + (r.get("Vulnerabilities") or []):
        cuenta[m.get("Severity", "UNKNOWN")] += 1
        if m.get("Severity") in ("HIGH", "CRITICAL"):
            print(f"  {m['Severity']:8} {m.get('ID') or m.get('VulnerabilityID')}  {r.get('Target')}  {m.get('Title','')[:90]}")
print("RESUMEN", " ".join(f"{s}={cuenta.get(s,0)}" for s in ("CRITICAL","HIGH","MEDIUM","LOW")))
PY
}

case $motor in
  terraform|opentofu)
    titulo "TFLint (errores y malas prácticas de Terraform)"
    salida=$(cd "$DIR" && tflint --format compact 2>&1) || true
    echo "${salida:-sin problemas}"
    n=$(grep -c ':[0-9]*:[0-9]*:' <<<"$salida" || true)
    resumen+=("TFLint $n"); (( n > 0 )) && advertencias=1
    tipo_checkov=terraform
    ;;
  cloudformation)
    titulo "cfn-lint (errores de la plantilla)"
    salida=$(cfn-lint --regions "$region" -- "$DIR"/*.yaml 2>&1) || true
    echo "${salida:-sin problemas}"
    n=$(grep -cE '^[EW][0-9]+' <<<"$salida" || true)
    resumen+=("cfn-lint $n"); (( n > 0 )) && advertencias=1
    tipo_checkov=cloudformation
    ;;
  pulumi)
    titulo "Pulumi: Checkov no analiza TypeScript"
    echo "Las reglas del equipo se aplican sobre la vista previa (paso 3, Conftest)."
    echo "Aquí se revisan las dependencias (Trivy) y los secretos (Gitleaks)."
    tipo_checkov=""
    ;;
esac

if [[ -n $tipo_checkov ]]; then
  titulo "Checkov (configuración insegura; los aceptados por diseño están marcados con checkov:skip)"
  checkov -d "$DIR" --framework "$tipo_checkov" -o json --soft-fail --quiet > "$GEN/checkov.json" 2>/dev/null || true
  salida=$(checkov_resumen "$GEN/checkov.json")
  grep -v '^RESUMEN' <<<"$salida" || true
  read -r _ aprobadas fallidas omitidas <<<"$(grep '^RESUMEN' <<<"$salida")"
  echo "Aprobadas $aprobadas · fallidas $fallidas · aceptadas por diseño $omitidas"
  resumen+=("Checkov $aprobadas ok/$fallidas fallas/$omitidas aceptadas"); (( fallidas > 0 )) && advertencias=1
fi

titulo "Trivy (segunda opinión: configuración y dependencias)"
if [[ $motor == pulumi ]]; then
  trivy fs --quiet --scanners vuln --format json --output "$GEN/trivy.json" "$DIR" || true
else
  trivy config --quiet --format json --output "$GEN/trivy.json" "$DIR" || true
fi
salida=$(trivy_resumen "$GEN/trivy.json")
grep -v '^RESUMEN' <<<"$salida" || true
linea=$(grep '^RESUMEN' <<<"$salida" | cut -d' ' -f2-)
echo "$linea"
resumen+=("Trivy ${linea// /, }")
grep -qE 'CRITICAL=[1-9]|HIGH=[1-9]' <<<"$linea" && advertencias=1

titulo "Gitleaks (secretos en el código de infra/)"
gitleaks dir "$INFRA" --config "$INFRA/.gitleaks.toml" --redact --no-banner \
  --report-format json --report-path "$GEN/gitleaks.json" --exit-code 0 2>&1 | tail -3 || true
secretos=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])) or []))' "$GEN/gitleaks.json" 2>/dev/null || echo 0)
if (( secretos > 0 )); then
  python3 -c 'import json,sys
for f in json.load(open(sys.argv[1])): print("  SECRETO", f["RuleID"], f["File"], "línea", f["StartLine"])' "$GEN/gitleaks.json"
  fallar "Gitleaks encontró $secretos secreto(s) en el código: se detiene la creación"
fi
resumen+=("Gitleaks sin secretos")

texto=$(printf '%s · ' "${resumen[@]}"); texto=${texto% · }
if (( advertencias )); then aviso "$texto"; else ok "$texto"; fi

# ==================================================================== 3. plan y políticas
siguiente "Plan y políticas del equipo"
politicas() { # politicas archivo.json namespace
  titulo "Conftest (politicas/$2.rego)"
  salida=$(conftest test "$1" -p "$INFRA/politicas" --namespace "$2" --no-color 2>&1) && codigo=0 || codigo=$?
  echo "$salida"
  (( codigo == 0 )) || fallar "las políticas del equipo rechazan el cambio (ver FAIL arriba)"
  avisos_politica=$(grep -c '^WARN' <<<"$salida" || true)
}

costo="Infracost: sin clave"
case $motor in
  terraform|opentofu)
    cd "$DIR"
    printf '{"slug":"%s","numero":%s,"region":"%s","plan":"%s","entorno":"%s","motor":"%s","disco":%s}\n' \
      "$slug" "$numero" "$region" "$plan" "$entorno" "$motor" "$disco" > "$GEN/entrada.tfvars.json"
    titulo "$TF init / plan"
    $TF init -input=false -reconfigure -backend-config="key=tenants/$slug/terraform.tfstate" -no-color >/dev/null
    if ! $TF plan -input=false -no-color -out="$GEN/plan.bin" -var-file="$GEN/entrada.tfvars.json" > "$GEN/plan.txt" 2>&1; then
      cat "$GEN/plan.txt"; fallar "$TF plan falló"
    fi
    grep -E '^(Plan:|No changes)|will be (created|destroyed|replaced)' "$GEN/plan.txt" || true
    $TF show -json "$GEN/plan.bin" > "$GEN/plan.json"
    politicas "$GEN/plan.json" terraform
    if [[ -n ${INFRACOST_API_KEY:-} ]]; then
      titulo "Infracost (costo mensual estimado)"
      infracost breakdown --path "$GEN/plan.json" --format json --out-file "$GEN/costo.json" --no-color >/dev/null 2>&1 || true
      infracost output --path "$GEN/costo.json" --format table --no-color 2>/dev/null | tail -25 || true
      total=$(json "$GEN/costo.json" totalMonthlyCost 2>/dev/null || echo "")
      [[ -n $total && $total != None ]] && costo=$(printf 'Infracost ~%.0f USD/mes' "$total")
    fi
    ;;
  pulumi)
    cd "$DIR"
    titulo "npm ci / pulumi preview"
    npm ci --no-audit --no-fund --loglevel=error
    pulumi stack select --create "$slug" --non-interactive
    pulumi config set numero "$numero" --non-interactive
    pulumi config set region "$region" --non-interactive
    pulumi config set plan "$plan" --non-interactive
    pulumi config set entorno "$entorno" --non-interactive
    pulumi config set disco "$disco" --non-interactive
    pulumi preview --json --non-interactive > "$GEN/preview.json"
    python3 -c 'import json,sys,collections; d=json.load(open(sys.argv[1])); print("Vista previa:", dict(collections.Counter(s["op"] for s in d.get("steps",[]))))' "$GEN/preview.json"
    politicas "$GEN/preview.json" pulumi
    costo="Infracost no analiza Pulumi"
    ;;
  cloudformation)
    cd "$DIR"
    stack="tenant-$slug"
    titulo "Change set de CloudFormation"
    if aws cloudformation describe-stacks --region "$region" --stack-name "$stack" >/dev/null 2>&1; then
      tipo_cambio=UPDATE; imagen=""
    else
      tipo_cambio=CREATE
      # Imagen propia de Packer solo al crear (cambiarla después recrearía los servidores).
      # Si la cuenta no deja buscar imágenes (política de la organización), se usa Amazon Linux.
      imagen=$(aws ec2 describe-images --region "$region" --owners self \
        --filters 'Name=name,Values=asistencia-tenant-*' 'Name=state,Values=available' \
        --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text 2>&1) \
        || { echo "No se pudo buscar la imagen propia: ${imagen:0:160}"; imagen=""; }
      [[ $imagen == ami-* ]] || imagen=""
    fi
    echo "Tipo: $tipo_cambio · imagen: ${imagen:-Amazon Linux 2023 (o la que ya tenía)}"
    python3 - "$PLATAFORMA" "$GEN/parametros.json" "$slug" "$numero" "$plan" "$tipo_cambio" "$imagen" "$disco" <<'PY'
import json, sys
plat, destino, slug, numero, plan, tipo, imagen, disco = sys.argv[1:]
p = json.load(open(plat, encoding="utf-8-sig"))
valores = {"Slug": slug, "Numero": numero, "Plan": plan, "Disco": disco, "PlataformaVpc": p["vpc_id"],
           "PlataformaCidr": p["cidr"], "PlataformaRegion": p["region"], "ClavesSsh": ",".join(p["claves_ssh"])}
parametros = [{"ParameterKey": k, "ParameterValue": v} for k, v in valores.items()]
if imagen:
    parametros.append({"ParameterKey": "ImagenPropia", "ParameterValue": imagen})
elif tipo == "UPDATE":
    parametros.append({"ParameterKey": "ImagenPropia", "UsePreviousValue": True})
json.dump(parametros, open(destino, "w"))
PY
    etiquetas=("Key=Proyecto,Value=asistencia" "Key=Tenant,Value=$slug" "Key=Plan,Value=$plan" "Key=Entorno,Value=$entorno" "Key=Motor,Value=cloudformation" "Key=GestionadoPor,Value=cloudformation")
    cambio="crear-$(date +%Y%m%d%H%M%S)"
    aws cloudformation create-change-set --region "$region" --stack-name "$stack" --change-set-name "$cambio" \
      --change-set-type "$tipo_cambio" --template-body "file://$DIR/tenant.yaml" \
      --parameters "file://$GEN/parametros.json" --tags "${etiquetas[@]}" >/dev/null
    if aws cloudformation wait change-set-create-complete --region "$region" --stack-name "$stack" --change-set-name "$cambio" 2>/dev/null; then
      aws cloudformation describe-change-set --region "$region" --stack-name "$stack" --change-set-name "$cambio" > "$GEN/cambios.json"
      python3 -c 'import json,sys,collections; d=json.load(open(sys.argv[1])); print("Cambios:", dict(collections.Counter(c["ResourceChange"]["Action"] for c in d.get("Changes",[]))))' "$GEN/cambios.json"
      politicas "$GEN/cambios.json" cloudformation
    else
      motivo=$(aws cloudformation describe-change-set --region "$region" --stack-name "$stack" --change-set-name "$cambio" --query StatusReason --output text)
      echo "$motivo"
      [[ $motivo == *"didn't contain changes"* || $motivo == *"No updates"* ]] || fallar "no se pudo crear el change set: $motivo"
      aws cloudformation delete-change-set --region "$region" --stack-name "$stack" --change-set-name "$cambio"
      cambio=""; avisos_politica=0
      echo "El stack ya está al día: no hay cambios que aplicar."
    fi
    costo="Infracost no analiza CloudFormation"
    ;;
esac
texto="Conftest sin rechazos (${avisos_politica:-0} avisos) · $costo"
if (( ${avisos_politica:-0} > 0 )); then aviso "$texto"; else ok "$texto"; fi

# ==================================================================== 4. crear
siguiente "$( (( actualizar )) && echo "Actualizar" || echo "Crear") la infraestructura ($motor)"
case $motor in
  terraform|opentofu)
    cd "$DIR"
    # Si apply falla, pipefail detiene el script y la marca de error sale del trap.
    $TF apply -input=false -no-color -auto-approve "$GEN/plan.bin" 2>&1 | grep --line-buffered -vE 'Still creating|Reading\.\.\.|Read complete' 
    ;;
  pulumi)
    cd "$DIR"
    pulumi up --yes --skip-preview --non-interactive --color never --suppress-progress
    ;;
  cloudformation)
    cd "$DIR"
    if [[ -n $cambio ]]; then
      aws cloudformation execute-change-set --region "$region" --stack-name "tenant-$slug" --change-set-name "$cambio"
      espera="stack-create-complete"; [[ $tipo_cambio == UPDATE ]] && espera="stack-update-complete"
      echo "Esperando a CloudFormation (tenant-$slug)…"
      aws cloudformation wait "$espera" --region "$region" --stack-name "tenant-$slug" \
        || fallar "el stack tenant-$slug no terminó bien (ver Eventos en la consola de CloudFormation)"
    fi
    salidas="$GEN/salidas-cfn.json"
    aws cloudformation describe-stacks --region "$region" --stack-name "tenant-$slug" --query 'Stacks[0].Outputs' > "$salidas"
    peering=$(python3 -c 'import json,sys; print({o["OutputKey"]:o["OutputValue"] for o in json.load(open(sys.argv[1]))}["Peering"])' "$salidas")
    echo "Ruta de vuelta en la plataforma ($REGION_PLAT)…"
    aws cloudformation deploy --region "$REGION_PLAT" --stack-name "tenant-$slug-ruta" \
      --template-file "$DIR/ruta-plataforma.yaml" --no-fail-on-empty-changeset \
      --parameter-overrides "TablaRutas=$(json "$PLATAFORMA" tabla_rutas)" "CidrTenant=10.$numero.0.0/16" "Peering=$peering" \
      --tags Proyecto=asistencia "Tenant=$slug" "Plan=$plan" Motor=cloudformation
    # La misma salida que Terraform y Pulumi (tenant.ps1 hace lo mismo en Windows).
    python3 - "$salidas" "$INFRA/generado/tenants/$slug.json" "$slug" "$region" "$plan" "$entorno" "$numero" "$DOMINIO" <<'PY'
import json, sys
salidas, destino, slug, region, plan, entorno, numero, dominio = sys.argv[1:]
v = {o["OutputKey"]: o["OutputValue"] for o in json.load(open(salidas))}
dom = f"{slug}.{dominio}"
datos = {"slug": slug, "region": region, "plan": plan, "entorno": entorno, "motor": "cloudformation",
         "numero": int(numero), "cidr": f"10.{numero}.0.0/16", "dominio": dom, "url": f"http://{dom}",
         "vpc_id": v["VpcId"], "peering": v["Peering"], "imagen": v.get("Imagen"),
         "servidores": {r: {"id": v[f"{r.title()}Id"], "tipo": v[f"{r.title()}Tipo"],
                            "privada": v[f"{r.title()}Privada"], "publica": v[f"{r.title()}Publica"]}
                        for r in ("frontend", "backend", "base")}}
json.dump(datos, open(destino, "w"), indent=2)
PY
    ;;
esac
SALIDA="$INFRA/generado/tenants/$slug.json"
[[ -f $SALIDA ]] || fallar "el motor no dejó generado/tenants/$slug.json"
imagen=$(json "$SALIDA" imagen 2>/dev/null || echo "")
imagen_nombre=""
if [[ $imagen == ami-* ]]; then
  imagen_nombre=$(aws ec2 describe-images --region "$region" --image-ids "$imagen" --query 'Images[0].Name' --output text 2>/dev/null || true)
  [[ $imagen_nombre == None ]] && imagen_nombre=""
fi
versiones "imagen=$imagen" "imagen_nombre=$imagen_nombre"
ok "red 10.$numero.0.0/16, peering y 3 servidores · imagen ${imagen_nombre:-${imagen:-?}}"

# ==================================================================== 5. ansible
siguiente "Configurar con Ansible"
cd "$INFRA"
python3 scripts/inventario.py "$slug" --en-plataforma
cd "$INFRA/ansible"
inicio=$SECONDS
ANSIBLE_STDOUT_CALLBACK=default ANSIBLE_DISPLAY_SKIPPED_HOSTS=false \
  ansible-playbook -i "inventarios/$slug.ini" tenant.yml -e tenant_invitacion=true
# Commit de la app que quedó en los servidores (lo escribe tenant.yml).
if [[ -f $GEN/version-app.json ]]; then
  versiones "app_desplegada=$(json "$GEN/version-app.json" backend 2>/dev/null | cut -c1-12 || true)"
fi
ok "app, base de datos, agentes y ruta en el gateway ($(( (SECONDS - inicio) / 60 )) min)"

# ==================================================================== actualizar: parches
if (( actualizar )) && [[ $parches == si ]]; then
  siguiente "Parches de seguridad del sistema (dnf)"
  ansible tenant -i "inventarios/$slug.ini" -b -m ansible.builtin.dnf -a "name=* state=latest security=true update_only=true"
  # needs-restarting -r: 1 = hace falta reiniciar (kernel o glibc nuevos), 0 = no.
  reinicio=$(ansible tenant -i "inventarios/$slug.ini" -b -o -m shell -a "dnf needs-restarting -r >/dev/null 2>&1; echo codigo=\$?" 2>/dev/null | grep -c 'codigo=1' || true)
  if (( reinicio > 0 )); then
    aviso "parches instalados; $reinicio servidor(es) necesitan reiniciar para aplicar el kernel (no se reinician solos)"
  else
    ok "parches de seguridad instalados (sin reinicio pendiente)"
  fi
fi

# ==================================================================== 6. verificar
siguiente "Verificar"
url="http://$slug.$DOMINIO"
codigo=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -H "Host: $slug.$DOMINIO" http://127.0.0.1/api/health || true)
[[ $codigo == 200 ]] || fallar "$url/api/health respondió $codigo"
echo "$url/api/health → 200 (gateway → peering → frontend → backend → base)"
ok "$url responde"
python3 -c 'import json,sys
r={"url":sys.argv[1],"motor":sys.argv[2],"region":sys.argv[3],"imagen":sys.argv[4] or None}
if sys.argv[5]: r.update(json.loads(sys.argv[5]))
print("::resultado::"+json.dumps(r))' "$url" "$motor" "$region" "$imagen" "$respaldo_previo"
