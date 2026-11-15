# Infraestructura del proyecto final

Plataforma multitenant: un **portal** crea universidades (tenants). Cada tenant tiene
su propia red y 3 servidores (frontend, backend, base), con su URL en nip.io y su
monitoreo en Grafana.

> Entregables escritos (arquitectura, flujo de creación, planes, herramientas,
> operaciones, estado, seguridad, aislamiento y guion de la demo):
> [DOCUMENTACION.md](DOCUMENTACION.md). Este LEEME es la guía para levantarlo a mano.

```
                                  internet
                                     │ http://<slug>.<ip>.nip.io
                       ┌─────────────▼──────────────┐
 VPC plataforma        │ vm-plataforma  10.0.1.10   │      ┌───────────────────────┐
 10.0.0.0/16           │ portal + gateway Nginx     │      │ vm-monitoreo 10.0.1.40│
 (us-east-2)           │ (worker de IaC, etapa 5)   │      │ Prometheus + Grafana  │
                       └─────────────┬──────────────┘      └───────────┬───────────┘
                    peering          │                                 │ métricas
          ┌──────────────────────────┼─────────────────────────────────┤ (peering)
          ▼                          ▼                                 ▼
 VPC tenant 10.1.0.0/16    VPC tenant 10.2.0.0/16          VPC tenant 10.3.0.0/16
 utepsa (us-east-2)        la-salle (us-east-2)            uagrm (us-west-2)
 frontend .20 · backend .10 · base .30 en cada uno
```

- **Aislamiento:** cada tenant está en su propia VPC. El peering no es transitivo:
  un tenant llega a la plataforma, pero no a otro tenant. Desde internet no se
  entra a ningún servidor de un tenant; todo pasa por el gateway.
- **Regiones:** tenants en us-east-2 (Ohio, junto a la plataforma), us-east-1 (Virginia)
  o us-west-2 (Oregón), con peering entre regiones. La organización de la cuenta
  (política `AdvancedModeRegionRestrictionSecurityControlPolicy`, editada en la cuenta
  administradora) solo permite esas 3. El portal admite **2 tenants por región** (cuota
  de 16 vCPU: cada tenant usa 6 y en Ohio la plataforma usa 4); se cambia con
  `PLATFORM_TENANTS_PER_REGION`. Azure se muestra deshabilitado.
- **Monitoreo automático:** Prometheus busca en AWS las instancias con la etiqueta
  `Proyecto=asistencia` y usa sus etiquetas (`Tenant`, `Plan`, `Rol`...). Un tenant
  nuevo aparece solo en Grafana.
- **Secretos:** los de la plataforma, en Ansible Vault. Los de cada tenant se
  generan solos (contraseñas distintas por tenant) en `generado/tenants/<slug>/`.
- **Sin claves de acceso de AWS en los servidores:** usan roles de IAM.

## Carpetas

```
infra/
├── claves/                 claves SSH públicas (.pub) que entran a todos los servidores
├── plataforma/             Terraform: VPC, vm-plataforma, vm-monitoreo, roles IAM, IP fija
├── tenant/
│   ├── terraform/          un tenant con Terraform y OpenTofu
│   ├── pulumi/             el mismo tenant con Pulumi (TypeScript)
│   └── cloudformation/     el mismo tenant con CloudFormation (tenant.ps1 lo crea y lo borra)
├── packer/                 imagen (AMI) de los tenants con todo preinstalado
├── scripts/
│   ├── inventario.py       JSON del tenant -> inventario de Ansible
│   └── aprovisionar.sh     crea o borra un tenant completo (lo usa el worker del portal)
├── politicas/              reglas del equipo (Conftest) sobre el plan de cada motor
├── ansible/
│   ├── plataforma.yml      configura vm-plataforma y vm-monitoreo
│   ├── tenant.yml          configura un tenant completo + su ruta en el gateway
│   ├── tareas/             un archivo por rol (postgresql.yml, backend.yml, grafana.yml...)
│   │   └── handlers.yml    reinicios compartidos (los usan todos)
│   ├── archivos/grafana/   paneles (.json) y alertas
│   └── group_vars/all/     vars.yml, monitoreo.yml, vault.yml (cifrado)
└── generado/               lo escribe cada apply (no va a git)
    ├── plataforma.json     datos de la red de la plataforma (los leen los tenants)
    └── tenants/<slug>.json salida del motor + <slug>/ con sus contraseñas
```

### El contrato de los motores

Todos los motores reciben las **mismas entradas** y dejan la **misma salida**:

| Entradas | Salida (`generado/tenants/<slug>.json`) |
| --- | --- |
| `slug`, `numero` (red 10.N), `region`, `plan`, `entorno` | `slug`, `region`, `plan`, `motor`, `cidr`, `url`, `servidores.{frontend,backend,base}.privada` |

Así Ansible, el gateway y Prometheus no necesitan saber qué motor creó el tenant.
Los cuatro crean exactamente lo mismo: la VPC, el peering (aceptado en la región de
la plataforma), la ruta de vuelta, 3 firewalls con 21 reglas y 3 servidores con las
mismas etiquetas.

---

# Guía: plataforma y primer tenant (a mano)

- **PowerShell** → Terraform
- **Ubuntu (WSL)** → Ansible y el script del inventario

El repo en WSL: `/mnt/d/Diplomado-2026/control-asistencia-academica/infra`.

## 0. Antes de empezar

1. Sube la rama `plataforma` a GitHub: los servidores clonan el código desde ahí.
   ```powershell
   git push -u origin plataforma
   ```
2. Revisa cuántas VPC tienes en la región (el límite es 5 por región y la VPC por defecto cuenta):
   ```powershell
   aws ec2 describe-vpcs --region us-east-2 --query "Vpcs[].[VpcId,CidrBlock,IsDefault]" --output table
   ```
   En us-east-2: VPC por defecto + plataforma + 3 tenants = 5. Repartir tenants en
   otras regiones también evita el límite.
3. Los planes usan tipos de la **capa gratuita** (`t3.micro`, `t3.small`, `c7i-flex.large`,
   `m7i-flex.large`...). La cuenta ya es de pago por uso y admite otros tipos, pero estos
   gastan menos créditos; si pides otro tipo, Terraform avisa antes de crear nada. Ver la lista:
   ```powershell
   aws ec2 describe-instance-types --region us-east-2 --filters Name=free-tier-eligible,Values=true --query "InstanceTypes[].InstanceType" --output table
   ```

## 1. Secretos de la plataforma (una vez, WSL)

```bash
cd /mnt/d/Diplomado-2026/control-asistencia-academica/infra/ansible
cp group_vars/all/vault.yml.ejemplo group_vars/all/vault.yml
nano group_vars/all/vault.yml           # 3 contraseñas: solo letras y números, 12+
ansible-vault encrypt group_vars/all/vault.yml
```

Usa la misma `~/.vault_asistencia` de las prácticas.

## 2. Crear la plataforma (PowerShell)

```powershell
cd D:\Diplomado-2026\control-asistencia-academica\infra\plataforma
terraform init
terraform apply
```

Escribe `generado\plataforma.json` y `ansible\inventarios\plataforma.ini`.

## 3. Configurar la plataforma (WSL, unos 10 minutos)

```bash
cd /mnt/d/Diplomado-2026/control-asistencia-academica/infra/ansible
ansible all -i inventarios/plataforma.ini -m ping
ansible-playbook -i inventarios/plataforma.ini plataforma.yml
```

Al final muestra el portal (`http://<ip>`) y Grafana (`http://<ip de vm-monitoreo>:3000`).
nip.io solo se usa para los tenants.

## 3b. Imagen de los tenants con Packer (recomendado, PowerShell)

Packer crea un servidor temporal, le ejecuta `packer/imagen.yml` (las **mismas tareas**
de `ansible/tareas/`) y guarda su disco como imagen: Node, Nginx, PostgreSQL, la app ya
compilada y los agentes de monitoreo. Los 4 motores usan sola la imagen más reciente
`asistencia-tenant-*` de la región; si no hay, usan Amazon Linux y Ansible instala todo.

```powershell
winget install Hashicorp.Packer      # una vez
cd D:\Diplomado-2026\control-asistencia-academica\infra\packer
packer init .
packer validate .
packer build .                       # 15-20 min (una imagen en cada una de las 3 regiones)
packer build -only="*.ohio" .        # solo una región
```

| | Sin imagen | Con imagen |
| --- | --- | --- |
| `tenant.yml` la primera vez | 10-15 min (instala y compila) | 2-3 min (solo configura) |

- Vuelve a crearla cuando cambie el código de la app: un tenant nuevo que use una imagen
  vieja funciona igual, pero Ansible recompila (tarda como sin imagen).
- Una imagen nueva **no** recrea los tenants que ya existen.
- Cada imagen cuesta poco (unos centavos al mes por región). Para borrar las viejas:
  EC2 → AMIs → *Deregister* y luego borrar su snapshot.
- `cloud-init` y Ansible siguen haciendo su parte: la imagen es lo común, cloud-init pone
  las claves SSH de cada servidor y Ansible lo propio de cada tenant.

## 4. Crear un tenant con Terraform (PowerShell)

```powershell
cd D:\Diplomado-2026\control-asistencia-academica\infra\tenant\terraform
terraform init -reconfigure -backend-config="key=tenants/utepsa/terraform.tfstate"
terraform apply -var slug=utepsa -var numero=1 -var region=us-east-2 -var plan=basico
```

- `numero` debe ser **distinto** para cada tenant (su red será `10.<numero>.0.0/16`).
- Cada tenant tiene su propio estado (`tenants/<slug>/`): para otro tenant, repite el
  `init -reconfigure` con su `key`.
- Con OpenTofu es igual, cambiando `terraform` por `tofu` y agregando `-var motor=opentofu`.
- Tamaños por plan (todos con 2 vCPU):

  | Plan | Frontend | Backend | Base | Disco |
  | --- | --- | --- | --- | --- |
  | basico | t3.micro (1 GB) | t3.small (2 GB) | t3.small (2 GB) | 20 GB |
  | estandar | t3.small (2 GB) | c7i-flex.large (4 GB) | c7i-flex.large (4 GB) | 30 GB |
  | avanzado | t3.small (2 GB) | m7i-flex.large (8 GB) | m7i-flex.large (8 GB) | 40 GB |

  Otro tamaño: `-var 'servidores={frontend={tipo="t3.micro",disco=20},backend={tipo="t3.small",disco=20},base={tipo="t3.small",disco=20}}'`

### 4b. El mismo tenant con Pulumi (PowerShell)

Una vez por PC: `npm install` en `infra\tenant\pulumi`. Usa como frase de cifrado la
misma de `vault_pulumi_passphrase` (la del worker), así el portal también puede manejar
ese stack. Cada tenant es un stack, y **el nombre del stack es el slug**.

```powershell
cd D:\Diplomado-2026\control-asistencia-academica\infra\tenant\pulumi
$env:PULUMI_CONFIG_PASSPHRASE = "la-frase-del-grupo"
pulumi stack init la-salle
pulumi up -c numero=2 -c region=us-east-2 -c plan=basico
```

Escribe `generado\tenants\la-salle.json` (lo mismo que Terraform) y `Pulumi.la-salle.yaml`
(las entradas del tenant: súbelo a git). Borrar:
`pulumi stack select la-salle`, `pulumi destroy`, `pulumi stack rm la-salle` y
borrar ese JSON.

### 4c. El mismo tenant con CloudFormation (PowerShell)

```powershell
cd D:\Diplomado-2026\control-asistencia-academica
.\infra\tenant\cloudformation\tenant.ps1 -Accion crear -Slug uagrm -Numero 3 -Region us-west-2 -Plan basico
```

Crea dos stacks: `tenant-uagrm` en la región del tenant (red, peering y servidores) y
`tenant-uagrm-ruta` en la región de la plataforma (la ruta de vuelta: un stack no puede
crear recursos en otra región). Escribe `generado\tenants\uagrm.json`. Borrar:
`tenant.ps1 -Accion borrar -Slug uagrm -Region us-west-2`.

Si PowerShell no deja ejecutarlo: `Unblock-File .\infra\tenant\cloudformation\tenant.ps1`.

## 5. Configurar el tenant (WSL, 10-15 minutos)

Igual para los cuatro motores (cambia solo el slug).

```bash
cd /mnt/d/Diplomado-2026/control-asistencia-academica/infra
python3 scripts/inventario.py utepsa
cd ansible
ansible all -i inventarios/utepsa.ini -m ping
ansible-playbook -i inventarios/utepsa.ini tenant.yml
```

Ansible entra a los servidores del tenant **saltando por vm-plataforma** (no tienen SSH
abierto a internet). Al final: `Listo: http://utepsa.<ip>.nip.io`.

- Usuario: `admin@example.com`
- Contraseña: `cat ../generado/tenants/utepsa/admin_password`

En Grafana aparece solo, en **Asistencia → Plataforma - Vista general** (1-2 minutos).

## 6. Borrar

```powershell
# Cada tenant (con su key)
cd D:\Diplomado-2026\control-asistencia-academica\infra\tenant\terraform
terraform init -reconfigure -backend-config="key=tenants/utepsa/terraform.tfstate"
terraform destroy -var slug=utepsa -var numero=1 -var region=us-east-2 -var plan=basico

# La plataforma, al final (los tenants usan su red)
cd ..\..\plataforma
terraform destroy
```

Después de borrar un tenant, quita su ruta del gateway (WSL):
`ansible vm-plataforma -i inventarios/plataforma.ini -b -m file -a "path=/etc/nginx/tenants/utepsa.conf state=absent"`
y vuelve a ejecutar `plataforma.yml` (en la etapa 6 lo hará el portal).

## Demo sugerida: 6 universidades, 3 regiones, 4 motores

| Región | Tenants | Motores |
| --- | --- | --- |
| us-east-2 (Ohio) | uagrm, utepsa | Terraform, CloudFormation |
| us-east-1 (Virginia) | la-salle, savio | Pulumi, OpenTofu |
| us-west-2 (Oregón) | upsa, unifranz | Terraform, CloudFormation |

Cuotas por región: 5 VPC y **16 vCPU**. Ohio: VPC por defecto + plataforma + 2 tenants = 4
VPC y 4 + 2 × 6 = 16 vCPU (justo al límite: con 2 tenants en Ohio, Packer no tiene lugar
para su servidor temporal; construye la imagen antes). Virginia y Oregón: 12 vCPU cada una.

## Demostraciones

| Qué | Cómo | Qué se ve |
| --- | --- | --- |
| Aislamiento | `ansible utepsa-frontend -i inventarios/utepsa.ini -m shell -a "timeout 3 bash -c '</dev/tcp/10.2.1.20/80' && echo ABIERTO \|\| echo CERRADO"` | `CERRADO`: no llega al tenant 2 |
| …pero la plataforma sí | igual desde `vm-plataforma` | `ABIERTO` |
| Sin entrada desde internet | `curl -m 5 http://<ip pública del frontend>` | no responde |
| Idempotencia | `tenant.yml` otra vez | `changed=0` |
| Monitoreo automático | Prometheus → Status → Targets | aparecen los tenants con su etiqueta |
| Netdata de un servidor | `ssh -L 19999:10.1.1.10:19999 ec2-user@<ip plataforma>` y abrir `http://localhost:19999` | panel en vivo |

---

# Crear tenants desde el portal (etapa 5)

```
 navegador ──► portal (asistencia-portal) ──► base del portal: platform_jobs
                                                   │
                       worker (asistencia-worker, usuario iac) toma el trabajo
                                                   │
                       infra/scripts/aprovisionar.sh crear --slug ... --motor ...
                         1 Validar
                         2 Escaneo: TFLint / cfn-lint, Checkov, Trivy, Gitleaks
                         3 Plan y políticas: Conftest (politicas/), Infracost
                         4 Crear: Terraform / OpenTofu / Pulumi / CloudFormation
                         5 Ansible: tenant.yml (app, agentes, ruta en el gateway)
                         6 Verificar: http://<slug>.<ip>.nip.io/api/health
                                                   │
                       el worker vincula la instalación e invita al administrador
```

- El panel muestra cada paso y el **registro en vivo** (Instituciones → la institución → Infraestructura).
- Las **advertencias** de los escáneres quedan en el log y no detienen nada. Sí
  detienen la creación: un **secreto** encontrado por Gitleaks o una regla `deny` de
  `politicas/` (tipo de servidor fuera del plan gratuito, un plan que borra recursos).
- Los hallazgos de Checkov **aceptados por diseño** están marcados en el código con
  `#checkov:skip=...` y su motivo (se ven como "aceptadas por diseño").
- Los trabajos se ejecutan **de a uno**. Si el worker se reinicia a mitad, el trabajo
  queda como fallido y se puede reintentar.
- El portal acepta los tenants por **HTTP** (`PLATFORM_ALLOW_HTTP_TENANTS=true`) porque
  nip.io no tiene certificados. Con HTTPS real (Let's Encrypt) se quitaría esa variable.
- Eliminar: botón **Eliminar infraestructura** (pide escribir el identificador). Borra la
  red y los servidores, quita la ruta del gateway y archiva sus contraseñas en
  `generado/borrados/` del servidor.

## Preparar (una vez)

1. En `group_vars/all/vault.yml` (`ansible-vault edit`), agrega:
   ```yaml
   vault_pulumi_passphrase: UnaFraseSoloLetrasYNumeros   # 12+, sin símbolos
   vault_infracost_api_key: ""                            # opcional (infracost.io, gratis)
   ```
2. `git push` (el servidor clona tu rama `plataforma`).
3. WSL: `ansible-playbook -i inventarios/plataforma.ini plataforma.yml`. Instala en
   vm-plataforma las herramientas (motores, Ansible y escáneres) y el servicio
   `asistencia-worker`, con su propia copia del repo en `/opt/iac/repo`.

## Usar

Portal → **Instituciones → Crear institución** → nombre, identificador, plan,
región, motor → **Crear institución**. Se abre su ficha con los pasos en vivo
(15-20 minutos sin imagen de Packer; menos con imagen). Al terminar aparecen la URL y
el enlace de **invitación** del administrador (vista previa: no se envía correo).

## Revisar en el servidor

```bash
ssh ec2-user@<ip plataforma>
sudo journalctl -u asistencia-worker -f      # lo que hace el worker
sudo -iu iac                                  # mismo entorno que el worker (en infra/)
bash scripts/aprovisionar.sh crear --slug prueba --motor terraform --region us-east-2 --plan basico --numero 9
ls generado/tenants/<slug>/                   # checkov.json, trivy.json, plan.json, contraseñas...
```

# Operar los tenants desde el portal (etapa 6)

- **Suspender / Reanudar** (Instituciones → la institución → Infraestructura). El worker
  ejecuta `aprovisionar.sh suspender|reanudar`: busca los 3 servidores por sus tags
  (`Proyecto=asistencia`, `Tenant=<slug>`), los apaga o enciende (`stop/start-instances`)
  y, al reanudar, espera a que `/api/health` responda. Los discos y la base se conservan;
  suspendido no consume horas de cómputo ni vCPU de la cuota (los discos sí cuestan).
  Funciona igual con los 4 motores porque no toca el estado de Terraform/Pulumi/CFN.
- **Monitoreo**: el portal consulta a Prometheus (vm-monitoreo, puerto 9090 por la red
  privada; regla `monitoreo_desde_portal`) las mismas métricas del panel de Grafana:
  CPU, memoria, disco, API, latencia, peticiones, conexiones de la base, agentes y
  alertas activas, por institución. Cada tarjeta enlaza a su panel en Grafana.
- **Auditoría**: tabla `platform_audit` (migración 007). Registra inicios de sesión
  (también los fallidos), solicitudes, registros, planes, invitaciones, activaciones y
  cada trabajo del worker (inicio y fin, con motor, región, duración y pasos).

Para aplicarla: `git push`, luego `terraform apply` en `infra\plataforma` (agrega la
regla 9090 desde el portal; no recrea nada) y `ansible-playbook -i inventarios/plataforma.ini
plataforma.yml` (variables `PLATFORM_PROMETHEUS_URL` / `PLATFORM_GRAFANA_URL`, migración y
worker nuevo).

# Versiones en cada despliegue (RF-13)

`aprovisionar.sh` anuncia con la marca `::versiones::` qué se usó en cada trabajo y el
worker lo guarda con el trabajo (`platform_jobs.versions`):

| Qué | De dónde sale |
| --- | --- |
| Código | rama y commit de la copia del repo del worker (`/opt/iac/repo`) |
| Aplicación | último commit de `admin-docente-alumno`, su versión (`package.json`) y el commit que quedó en los servidores (`tenant.yml` lo escribe en `generado/tenants/<slug>/version-app.json`) |
| Plantilla | carpeta del motor (`tenant/terraform`, `tenant/pulumi`, `tenant/cloudformation`), su último commit y un sha256 de sus archivos |
| Motor | versión de Terraform, OpenTofu, Pulumi o AWS CLI, y del proveedor de AWS (`.terraform.lock.hcl` / `package-lock.json`) |
| Ansible | versión de ansible-core y último commit de `infra/ansible` |
| Imagen | AMI de Packer usada y su nombre (`asistencia-tenant-<fecha>`) |
| Escáneres | versiones de Checkov, Trivy, Gitleaks, Conftest, TFLint o cfn-lint |

Se ven en el portal (Instituciones → la institución → Infraestructura → "Versiones usadas
en este trabajo") y en Auditoría (detalle del despliegue).

# Errores, alertas y correos (RF-26 a RF-29)

- **Errores del backend (RF-26):** el Nginx del frontend escribe una línea por cada
  respuesta de `/api` en `/var/log/nginx-api/acceso.log` y el Collector las cuenta:
  `nginx_api_peticiones_total` y `nginx_api_errores_total` (5xx). Se ven en Grafana
  (Tenant - Detalle → "Errores del backend", Plataforma → "Errores del backend") y en
  la tarjeta de cada institución del portal.
- **Alerta de errores (RF-28):** regla "Aumentan los errores del backend (5xx)": más
  de 5 errores en 5 minutos. Las otras reglas: servidor o agente caído, API sin
  respuesta, servicio detenido, CPU, memoria, disco y conexiones de PostgreSQL.
- **Alertas en el portal (RF-29):** Grafana envía cada alerta (al dispararse y al
  resolverse) a `http://<ip privada plataforma>/api/platform/alerts/grafana` con un
  token (`generado/alertas-token`, se genera solo). El gateway solo acepta ese aviso
  desde la red privada. Monitoreo muestra las alertas activas con su tenant y hora de
  detección, y los eventos de las últimas 24 horas.
- **Por entorno (RF-27):** filtro "Entorno" en Monitoreo del portal y en los dos
  paneles de Grafana.
- **Correos (opcional):** en `vault.yml` agrega tu correo y una cuenta de Gmail con
  [contraseña de aplicación](https://myaccount.google.com/apppasswords):
  ```yaml
  vault_alertas_correos: "tu-correo@ejemplo.com"
  vault_alertas_admin_tenant: true      # también al administrador del tenant afectado
  vault_smtp_user: "cuenta-que-envia@gmail.com"
  vault_smtp_password: "abcdabcdabcdabcd"
  ```
  Las invitaciones siguen en vista previa; el SMTP solo se usa para las alertas.

Para aplicarlo: `git push` y `plataforma.yml` (Grafana, portal, gateway y la copia del
repo del worker). Los tenants nuevos ya traen el registro de errores; en los que ya
existen, volver a correr `tenant.yml` desde el servidor (como lo hace el worker):

```bash
ssh ec2-user@<ip plataforma>
sudo -iu iac                                   # queda en /opt/iac/repo/infra
python3 scripts/inventario.py <slug> --en-plataforma
cd ansible && ansible-playbook -i inventarios/<slug>.ini tenant.yml -e tenant_invitacion=true
```

### Alerta de ejemplo para la demo

Detener la API de un tenant: en 1-2 minutos se dispara "La API no responde" (y, si
alguien usa la app, "Aumentan los errores del backend" por los 502), aparece en
Monitoreo del portal y llega el correo. Al encenderla, se resuelve sola.

```bash
# en el servidor, como iac y en infra/ansible (después de inventario.py, ver arriba)
ansible <slug>-backend -i inventarios/<slug>.ini -b -m systemd -a "name=asistencia-api state=stopped"
ansible <slug>-backend -i inventarios/<slug>.ini -b -m systemd -a "name=asistencia-api state=started"
```

## Respaldos (RF-19)

Instituciones → el tenant → **Respaldos de la base de datos**: respaldar ahora, lista de
respaldos y restaurar. Programados según el plan (semanal o diario). Se guardan en el
bucket `asistencia-respaldos-<cuenta>` (lo crea `infra/plataforma/respaldos.tf`). Detalle
en DOCUMENTACION.md, sección 6.6.

## Actualizar un tenant (RF-15)

Desde el portal: **Actualizar versión** en la institución.

- Antes de empezar muestra qué partes cambiaron desde su último despliegue: app,
  plantillas del motor, Ansible, escaneos y políticas.
- El worker trae el último commit de la rama.
- Vuelve a pasar los escaneos y las políticas.
- El motor aplica solo la diferencia.
- Ansible despliega la app nueva.
- Opciones:
  - respaldo previo (por defecto);
  - parches de seguridad del sistema (`dnf upgrade --security`, sin reiniciar).

Detalle en DOCUMENTACION.md, sección 6.2.

Para aplicarlo:

1. `git push`.
2. `plataforma.yml`. La migración 014 se aplica sola al reiniciar el portal.

La primera comprobación completa el historial de la copia del worker
(`git fetch --unshallow`).
