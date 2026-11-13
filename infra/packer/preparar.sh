#!/usr/bin/env bash
# Lo ejecuta Packer (como root) en el servidor temporal.
set -euo pipefail

echo "==> Ansible (solo mientras se construye la imagen)"
dnf install -y python3-pip
pip3 install --quiet ansible-core

echo "==> imagen.yml"
cd /tmp/imagen
ANSIBLE_STDOUT_CALLBACK=default ANSIBLE_FORCE_COLOR=0 \
  ansible-playbook -i localhost, -c local imagen.yml

echo "==> Limpieza"
pip3 uninstall -y --quiet ansible-core
rm -rf /tmp/imagen /root/.ansible /root/.cache
dnf clean all
# Que cada servidor nuevo haga su primer arranque completo (claves SSH propias, cloud-init...).
cloud-init clean --logs
# Sin historial ni claves autorizadas del servidor temporal.
rm -f /home/ec2-user/.ssh/authorized_keys /root/.bash_history /home/ec2-user/.bash_history
