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
│   └── terraform/          un tenant (Terraform y OpenTofu)
│                           (pulumi/ y cloudformation/ en la etapa 4, con las mismas entradas)
├── scripts/inventario.py   JSON del tenant -> inventario de Ansible
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
3. Revisa el límite de vCPU (Service Quotas → EC2 → *Running On-Demand Standard
   instances*). Un tenant `basico` usa 6 vCPU (t3.micro + 2 × t3.medium) y la plataforma 4.

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

Al final muestra el portal (`http://plataforma.<ip>.nip.io`) y Grafana (`http://grafana.<ip>.nip.io`).

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
- Para pruebas más baratas, servidores más chicos:
  `-var 'servidores={frontend={tipo="t3.micro",disco=16},backend={tipo="t3.small",disco=16},base={tipo="t3.small",disco=16}}'`

## 5. Configurar el tenant (WSL, 10-15 minutos)

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

## Demostraciones

| Qué | Cómo | Qué se ve |
| --- | --- | --- |
| Aislamiento | `ansible utepsa-frontend -i inventarios/utepsa.ini -m shell -a "timeout 3 bash -c '</dev/tcp/10.2.1.20/80' && echo ABIERTO \|\| echo CERRADO"` | `CERRADO`: no llega al tenant 2 |
| …pero la plataforma sí | igual desde `vm-plataforma` | `ABIERTO` |
| Sin entrada desde internet | `curl -m 5 http://<ip pública del frontend>` | no responde |
| Idempotencia | `tenant.yml` otra vez | `changed=0` |
| Monitoreo automático | Prometheus → Status → Targets | aparecen los tenants con su etiqueta |
| Netdata de un servidor | `ssh -L 19999:10.1.1.10:19999 ec2-user@<ip plataforma>` y abrir `http://localhost:19999` | panel en vivo |

## Pendiente (siguientes etapas)

- **Etapa 3:** Packer (imágenes con todo instalado: el tenant tarda minutos).
- **Etapa 4:** el mismo tenant con Pulumi y CloudFormation.
- **Etapa 5:** el portal crea tenants (worker). El portal solo vincula tenants con
  **HTTPS** (`invitations.js`): hay que decidir entre certificados de Let's Encrypt
  en el gateway o permitir HTTP para la demo con una variable.
