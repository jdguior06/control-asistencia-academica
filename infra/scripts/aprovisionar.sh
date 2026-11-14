#!/usr/bin/env bash
# Crea o borra UN tenant completo, con cualquiera de los 4 motores. Lo ejecuta el
# worker del portal en vm-plataforma, y también se puede ejecutar a mano allí:
#
#   sudo -iu iac
#   cd /opt/iac/repo/infra
#   bash scripts/aprovisionar.sh crear  --slug utepsa --motor terraform --region us-east-2 --plan basico --numero 1
#   bash scripts/aprovisionar.sh borrar --slug utepsa --motor terraform --region us-east-2 --plan basico --numero 1
#
# Pasos al crear:
#   1 Validar   2 Escaneo de seguridad del código   3 Plan y políticas (Conftest, Infracost)
#   4 Crear la infraestructura   5 Configurar con Ansible   6 Verificar
#
# Cada paso imprime marcas que el portal convierte en la lista de pasos:
#   ::paso::N::Título   ::ok::N::resumen   ::aviso::N::resumen   ::error::N::motivo
#   ::resultado::{json}  (al final)
# Las advertencias de los escáneres NO detienen la creación; sí la detienen un
# secreto encontrado por Gitleaks o una regla "deny" de las políticas (politicas/).
set -Eeuo pipefail

INFRA=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# ------------------------------------------------------------------ marcas
PASO=0
paso()   { PASO=$1; echo "::paso::$1::$2"; }
ok()     { echo "::ok::$PASO::$*"; }
aviso()  { echo "::aviso::$PASO::$*"; }
fallar() { echo "::error::$PASO::$*"; exit 1; }
titulo() { echo; echo "──── $* ────"; }
trap 'echo "::error::$PASO::Falló: ${BASH_COMMAND:0:160}"' ERR

# ------------------------------------------------------------------ entradas
uso() { echo "Uso: $0 crear|borrar --slug S --motor M --region R --plan P [--entorno E] --numero N"; exit 2; }
accion=${1:-}; [[ $# -gt 0 ]] && shift
slug=""; motor=""; region="us-east-2"; plan="basico"; entorno="production"; numero=0
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || uso
  case $1 in
    --slug) slug=$2 ;; --motor) motor=$2 ;; --region) region=$2 ;;
    --plan) plan=$2 ;; --entorno) entorno=$2 ;; --numero) numero=$2 ;;
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
[[ $accion == crear || $accion == borrar ]] || fallar "acción '$accion' (crear o borrar)"
[[ $slug =~ ^[a-z0-9]+(-[a-z0-9]+)*$ && ${#slug} -ge 3 && ${#slug} -le 30 ]] || fallar "slug '$slug' no válido (3 a 30: minúsculas, números y guiones)"
[[ $motor =~ ^(terraform|opentofu|pulumi|cloudformation)$ ]] || fallar "motor '$motor' no válido"
[[ $region =~ ^(us-east-1|us-east-2|us-west-2)$ ]] || fallar "región '$region' no disponible (us-east-1, us-east-2, us-west-2)"
[[ $plan =~ ^(basico|estandar|avanzado)$ ]] || fallar "plan '$plan' sin infraestructura definida"
[[ $entorno =~ ^(production|staging)$ ]] || fallar "entorno '$entorno' no válido"
[[ $numero =~ ^[0-9]+$ && $numero -ge 1 && $numero -le 250 ]] || fallar "número de red '$numero' (1 a 250)"
PLATAFORMA="$INFRA/generado/plataforma.json"
[[ -f $PLATAFORMA ]] || fallar "falta generado/plataforma.json (lo copia plataforma.yml)"
DOMINIO=$(json "$PLATAFORMA" dominio)
REGION_PLAT=$(json "$PLATAFORMA" region)

necesarias=(python3 aws)
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

# ==================================================================== 2. escaneo
paso 2 "Escaneo de seguridad del código"
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
paso 3 "Plan y políticas del equipo"
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
    printf '{"slug":"%s","numero":%s,"region":"%s","plan":"%s","entorno":"%s","motor":"%s"}\n' \
      "$slug" "$numero" "$region" "$plan" "$entorno" "$motor" > "$GEN/entrada.tfvars.json"
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
      imagen=$(aws ec2 describe-images --region "$region" --owners self \
        --filters 'Name=name,Values=asistencia-tenant-*' 'Name=state,Values=available' \
        --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
      [[ $imagen == ami-* ]] || imagen=""
    fi
    echo "Tipo: $tipo_cambio · imagen: ${imagen:-Amazon Linux 2023 (o la que ya tenía)}"
    python3 - "$PLATAFORMA" "$GEN/parametros.json" "$slug" "$numero" "$plan" "$tipo_cambio" "$imagen" <<'PY'
import json, sys
plat, destino, slug, numero, plan, tipo, imagen = sys.argv[1:]
p = json.load(open(plat, encoding="utf-8-sig"))
valores = {"Slug": slug, "Numero": numero, "Plan": plan, "PlataformaVpc": p["vpc_id"],
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
paso 4 "Crear la infraestructura ($motor)"
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
ok "red 10.$numero.0.0/16, peering y 3 servidores · imagen ${imagen:-?}"

# ==================================================================== 5. ansible
paso 5 "Configurar con Ansible"
cd "$INFRA"
python3 scripts/inventario.py "$slug" --en-plataforma
cd "$INFRA/ansible"
inicio=$SECONDS
ANSIBLE_STDOUT_CALLBACK=default ANSIBLE_DISPLAY_SKIPPED_HOSTS=false \
  ansible-playbook -i "inventarios/$slug.ini" tenant.yml -e tenant_invitacion=true
ok "app, base de datos, agentes y ruta en el gateway ($(( (SECONDS - inicio) / 60 )) min)"

# ==================================================================== 6. verificar
paso 6 "Verificar"
url="http://$slug.$DOMINIO"
codigo=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -H "Host: $slug.$DOMINIO" http://127.0.0.1/api/health || true)
[[ $codigo == 200 ]] || fallar "$url/api/health respondió $codigo"
echo "$url/api/health → 200 (gateway → peering → frontend → backend → base)"
ok "$url responde"
python3 -c 'import json,sys; print("::resultado::"+json.dumps({"url":sys.argv[1],"motor":sys.argv[2],"region":sys.argv[3],"imagen":sys.argv[4] or None}))' \
  "$url" "$motor" "$region" "$imagen"
