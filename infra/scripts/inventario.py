#!/usr/bin/env python3
"""Escribe el inventario de Ansible de un tenant.

Lee los datos que dejó el motor (Terraform, OpenTofu, Pulumi o CloudFormation)
y los de la plataforma, y escribe infra/ansible/inventarios/<slug>.ini.

    python3 scripts/inventario.py utepsa                  # desde tu PC (salta por la plataforma)
    python3 scripts/inventario.py utepsa --en-plataforma  # desde el propio servidor plataforma (worker)

Entradas:
    infra/generado/plataforma.json        lo escribe infra/plataforma
    infra/generado/tenants/<slug>.json    lo escribe el motor del tenant (mismo formato en todos)
"""

import argparse
import json
import sys
from pathlib import Path

INFRA = Path(__file__).resolve().parent.parent
ROLES = ("frontend", "backend", "base")


def leer_json(ruta: Path) -> dict:
    if not ruta.exists():
        sys.exit(f"No existe {ruta}. ¿Hiciste el apply de la plataforma y del tenant?")
    # utf-8-sig: acepta también archivos guardados desde PowerShell (con BOM).
    return json.loads(ruta.read_text(encoding="utf-8-sig"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("slug", help="identificador del tenant (ej. utepsa)")
    parser.add_argument("--en-plataforma", action="store_true",
                        help="Ansible corre en el servidor plataforma: conexión local y sin salto SSH")
    args = parser.parse_args()

    plataforma = leer_json(INFRA / "generado" / "plataforma.json")
    tenant = leer_json(INFRA / "generado" / "tenants" / f"{args.slug}.json")

    faltan = [rol for rol in ROLES if rol not in tenant.get("servidores", {})]
    if tenant.get("slug") != args.slug or faltan:
        sys.exit(f"{args.slug}.json no tiene el formato esperado (faltan: {', '.join(faltan) or 'slug'}).")

    usuario = plataforma["usuario_ssh"]
    ip_publica = plataforma["ip_publica"]
    privadas = plataforma["ip_privadas"]

    lineas = [
        f"# Generado por scripts/inventario.py ({tenant['motor']}). No editar.",
        "[plataforma]",
        f"vm-plataforma ansible_host={'127.0.0.1 ansible_connection=local' if args.en_plataforma else ip_publica}"
        f" ip_privada={privadas['plataforma']}",
        "",
    ]
    for rol in ROLES:
        privada = tenant["servidores"][rol]["privada"]
        lineas += [f"[{rol}]", f"{args.slug}-{rol} ansible_host={privada} ip_privada={privada}", ""]

    lineas += ["[tenant:children]", *ROLES, ""]

    if not args.en_plataforma:
        # Los servidores del tenant solo aceptan SSH desde la red de la plataforma:
        # Ansible entra saltando por el servidor plataforma.
        salto = (f"ssh -W %h:%p -q -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no "
                 f"-o UserKnownHostsFile=/dev/null {usuario}@{ip_publica}")
        lineas += ["[tenant:vars]", f"ansible_ssh_common_args='-o ProxyCommand=\"{salto}\"'", ""]

    lineas += [
        "[all:vars]",
        f"ansible_user={usuario}",
        f"dominio={plataforma['dominio']}",
        f"ip_privada_monitoreo={privadas['monitoreo']}",
        f"tenant_slug={tenant['slug']}",
        f"tenant_plan={tenant['plan']}",
        f"tenant_entorno={tenant['entorno']}",
        f"tenant_region={tenant['region']}",
        f"tenant_motor={tenant['motor']}",
        "",
    ]

    destino = INFRA / "ansible" / "inventarios" / f"{args.slug}.ini"
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text("\n".join(lineas), encoding="utf-8")
    print(f"Inventario: {destino.relative_to(INFRA)}")
    print(f"Siguiente:  cd {INFRA.name}/ansible && ansible-playbook -i inventarios/{args.slug}.ini tenant.yml")


if __name__ == "__main__":
    main()
