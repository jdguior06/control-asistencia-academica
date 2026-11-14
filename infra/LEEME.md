# Infraestructura del proyecto final

Plataforma multitenant: un **portal** crea universidades (tenants). Cada tenant tiene
su propia red y 3 servidores (frontend, backend, base), con su URL en nip.io y su
monitoreo en Grafana.

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
- **Regiones:** la plataforma está en us-east-2; un tenant puede estar en
  us-east-1, us-east-2 o us-west-2 (peering entre regiones).
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
3. La cuenta está en el **plan gratuito** de AWS: solo admite algunos tipos de servidor
   (`t3.micro`, `t3.small`, `c7i-flex.large`, `m7i-flex.large`...). Los planes ya los usan;
   si pides otro tipo, Terraform avisa antes de crear nada. Ver la lista:
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
packer build .                       # 15-20 min: construye la imagen en las 3 regiones a la vez
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

## Demo sugerida: 3 universidades, 3 motores, 2 regiones

| Tenant | Motor | Región | numero |
| --- | --- | --- | --- |
| utepsa | Terraform | us-east-2 | 1 |
| la-salle | Pulumi | us-east-2 | 2 |
| uagrm | CloudFormation | us-west-2 | 3 |

En us-east-2 quedan 4 VPC (por defecto, plataforma y 2 tenants): no hace falta pedir más cuota.

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

## Pendiente (siguientes etapas)

- **Etapa 6:** suspender y reanudar tenants; monitoreo y auditoría del portal con datos reales.
- **Trazas** de la app (OpenTelemetry → Tempo → Grafana).
