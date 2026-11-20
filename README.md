# Plataforma multitenant de control de asistencia

Un **portal** crea instituciones educativas (tenants). Cada una recibe su propia copia de la aplicación de asistencia, con su red y 3 servidores (frontend, backend y base de datos) en AWS, creados con infraestructura como código.

> 🎓 Proyecto final del diplomado **Cloud Infrastructure & DevSecOps** (FICCT, U.A.G.R.M.), 2026. Trabajo en grupo: este repositorio es la versión de **Juan Diego Guirapoigua Oregua**, elegida por el equipo para la defensa. Repositorio del grupo: [Jorgito-cc/control-asistencia-academica](https://github.com/Jorgito-cc/control-asistencia-academica).

## Qué contiene

| Carpeta | Qué es | Tecnologías |
| --- | --- | --- |
| [Admin-institucional](Admin-institucional/) | Portal de la plataforma: planes, creación y seguimiento de tenants, solicitudes, invitaciones, monitoreo y auditoría. | React, Vite, Express, PostgreSQL |
| [admin-docente-alumno](admin-docente-alumno/) | Aplicación de asistencia de cada institución: docentes, módulos, asistencias e importación desde Excel. | React, Vite, Tailwind, NestJS (arquitectura hexagonal), TypeORM, PostgreSQL |
| [infra](infra/) | Infraestructura como código de la plataforma y de cada tenant. | Terraform, OpenTofu, Pulumi, CloudFormation, Packer, Ansible, Prometheus, Grafana |

## Infraestructura

- **Aislamiento:** cada tenant vive en su propia VPC. El peering con la plataforma no es transitivo, así que un tenant no llega a otro, y desde internet todo pasa por un gateway Nginx.
- **Cuatro motores equivalentes:** el mismo tenant se crea con Terraform, OpenTofu, Pulumi o CloudFormation, con un contrato común.
- **Imágenes con Packer:** la imagen de los tenants ya trae todo instalado y reduce la configuración de 10-15 a 2-3 minutos.
- **Configuración con Ansible** y claves SSH instaladas con cloud-init.
- **Monitoreo automático:** Prometheus descubre los servidores por etiquetas de AWS y Grafana muestra paneles y alertas por correo.
- **Seguridad:** roles IAM en lugar de claves de AWS en los servidores, secretos en Ansible Vault, estado en un bucket S3 privado, cifrado y con bloqueo, y escáneres antes de crear (TFLint, cfn-lint, Checkov, Trivy, Gitleaks, Conftest e Infracost).
- **Regiones:** us-east-2, us-east-1 y us-west-2, con peering entre regiones.

Documentación completa: [infra/DOCUMENTACION.md](infra/DOCUMENTACION.md) (arquitectura, flujo, planes, operaciones, seguridad y guion de la demo) y [infra/LEEME.md](infra/LEEME.md) (guía paso a paso).

## Arranque local de las aplicaciones

| Proyecto | Frontend local | API local |
| --- | --- | --- |
| Admin-institucional | `http://127.0.0.1:5175` | `http://127.0.0.1:4300/api` |
| admin-docente-alumno | `http://localhost:5173` | `http://localhost:3000/api` |

Usa Node.js 22.12 o posterior y PostgreSQL. Crea una base y un usuario para la
plataforma y otra base con su propio usuario para la institución. Sigue los pasos
de cada proyecto para preparar su `server/.env` desde `.env.example`. Cada backend
aplica sus propias migraciones al iniciar.

1. [Iniciar la plataforma central](Admin-institucional/README.md).
2. [Iniciar la aplicación de asistencia](admin-docente-alumno/README.md).

Para vincular una instalación, el backend central consulta la URL pública de
asistencia y solicita por HTTP una invitación para su administrador. Habilita esa
URL en `PLATFORM_TENANT_ORIGINS` del backend central. Configura
`PLATFORM_TENANT_SLUG` y `PLATFORM_BOOTSTRAP_KEY` en el backend de asistencia.
Cada backend conserva sus usuarios y sus datos en su propia base.

## Autor

Juan Diego Guirapoigua Oregua · [@jdguior06](https://github.com/jdguior06)
