// Un tenant completo con Pulumi: lo mismo que ../terraform, recurso por recurso.
//
//   red propia 10.N.0.0/16 ──peering──► plataforma 10.0.0.0/16
//   3 servidores (frontend .20, backend .10, base .30), vacíos: los configura Ansible
//
// Entradas (iguales en todos los motores): slug = nombre del stack, numero, region, plan, entorno.
// Salida: ../../generado/tenants/<slug>.json, con el mismo formato que Terraform.

import * as fs from "fs";
import * as path from "path";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// ---------------------------------------------------------------- entradas

type Rol = "frontend" | "backend" | "base";
type Tamano = { tipo: string; disco: number };

const config = new pulumi.Config();
const slug = pulumi.getStack(); // el stack se llama como el tenant
const numero = config.requireNumber("numero");
const region = config.get("region") ?? "us-east-2";
const plan = config.get("plan") ?? "basico";
const entorno = config.get("entorno") ?? "production";
const motor = "pulumi";

// Las mismas reglas que las validaciones de Terraform (variables.tf).
function comprobar(condicion: boolean, mensaje: string): void {
  if (!condicion) throw new Error(mensaje);
}
comprobar(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length >= 3 && slug.length <= 30,
  "El stack (slug) debe tener 3 a 30 caracteres: minúsculas, números y guiones (ej. utepsa).");
comprobar(Number.isInteger(numero) && numero >= 1 && numero <= 250, "numero debe ser un entero entre 1 y 250.");
comprobar(["us-east-1", "us-east-2", "us-west-2"].includes(region), "region debe ser us-east-1, us-east-2 o us-west-2.");
comprobar(["basico", "estandar", "avanzado"].includes(plan), "plan debe ser basico, estandar o avanzado.");
comprobar(["production", "staging"].includes(entorno), "entorno debe ser production o staging.");

// Datos de la plataforma (los escribe infra/plataforma con terraform apply).
// Pulumi ejecuta el programa en la carpeta del proyecto (infra/tenant/pulumi).
const infra = path.resolve(process.cwd(), "..", "..");
const archivoPlataforma = path.join(infra, "generado", "plataforma.json");
comprobar(fs.existsSync(archivoPlataforma), `No existe ${archivoPlataforma}: primero crea la plataforma.`);
const plataforma = JSON.parse(fs.readFileSync(archivoPlataforma, "utf8").replace(/^﻿/, ""));

// Tamaños por plan: la misma tabla que Terraform (locales.tf) y el portal (005_planes_free_tier.sql).
const planes: Record<string, Record<Rol, Tamano>> = {
  basico: {
    frontend: { tipo: "t3.micro", disco: 20 },
    backend: { tipo: "t3.small", disco: 20 },
    base: { tipo: "t3.small", disco: 20 },
  },
  estandar: {
    frontend: { tipo: "t3.small", disco: 30 },
    backend: { tipo: "c7i-flex.large", disco: 30 },
    base: { tipo: "c7i-flex.large", disco: 30 },
  },
  avanzado: {
    frontend: { tipo: "t3.small", disco: 40 },
    backend: { tipo: "m7i-flex.large", disco: 40 },
    base: { tipo: "m7i-flex.large", disco: 40 },
  },
};
// Opcional, otro tamaño: pulumi config set --path servidores.backend.tipo t3.small (y así cada uno)
const tamanos: Record<Rol, Tamano> = config.getObject<Record<Rol, Tamano>>("servidores") ?? planes[plan];

// Plan gratuito de AWS: solo estos tipos (ver locales.tf).
const tiposPermitidos = ["t3.micro", "t3.small", "t8i.micro", "t8i.small", "c7i-flex.large", "m7i-flex.large"];
const roles: Rol[] = ["frontend", "backend", "base"];
for (const rol of roles) {
  const tipo = tamanos[rol]?.tipo;
  comprobar(tiposPermitidos.includes(tipo),
    `El tipo ${tipo} (${rol}) no está permitido en el plan gratuito de AWS. Usa uno de: ${tiposPermitidos.join(", ")}.`);
}

const nombre = `tenant-${slug}`;
const cidr = `10.${numero}.0.0/16`;
const subred = `10.${numero}.1.0/24`;
const ipFinal: Record<Rol, number> = { backend: 10, frontend: 20, base: 30 };
const dominio = `${slug}.${plataforma.dominio}`;
comprobar(cidr !== plataforma.cidr, "La red del tenant no puede ser la misma que la de la plataforma.");

// Prometheus lee estas etiquetas para saber de quién es cada servidor.
const etiquetas = {
  Proyecto: "asistencia",
  Tenant: slug,
  Plan: plan,
  Entorno: entorno,
  Motor: motor,
  GestionadoPor: motor,
};

// ---------------------------------------------------------------- proveedores

// Región del tenant (la del formulario).
const tenant = new aws.Provider("tenant", { region: region as aws.Region, defaultTags: { tags: etiquetas } });
// Región de la plataforma: aceptar el peering y agregar la ruta de vuelta.
const enPlataforma = new aws.Provider("plataforma", {
  region: plataforma.region as aws.Region,
  defaultTags: { tags: etiquetas },
});
const opTenant = { provider: tenant };
const opPlataforma = { provider: enPlataforma };

// ---------------------------------------------------------------- red

const zonas = aws.getAvailabilityZonesOutput({ state: "available" }, opTenant);

const vpc = new aws.ec2.Vpc("vpc", {
  cidrBlock: cidr,
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: { Name: `${nombre}-vpc` },
}, opTenant);

// Salida a internet (paquetes, git clone). Nadie entra desde internet: ver los firewalls.
const igw = new aws.ec2.InternetGateway("igw", { vpcId: vpc.id, tags: { Name: `${nombre}-igw` } }, opTenant);

const subnet = new aws.ec2.Subnet("subred", {
  vpcId: vpc.id,
  cidrBlock: subred,
  availabilityZone: zonas.names[0],
  mapPublicIpOnLaunch: true,
  tags: { Name: `${nombre}-subred` },
}, opTenant);

// Peering: lo pide el tenant (en su región)...
const peering = new aws.ec2.VpcPeeringConnection("peering", {
  vpcId: vpc.id,
  peerVpcId: plataforma.vpc_id,
  peerRegion: plataforma.region,
  autoAccept: false,
  tags: { Name: `${nombre}-a-plataforma` },
}, opTenant);

// ...y lo acepta la plataforma (en la región de la plataforma).
const aceptado = new aws.ec2.VpcPeeringConnectionAccepter("peering-aceptado", {
  vpcPeeringConnectionId: peering.id,
  autoAccept: true,
  tags: { Name: `${nombre}-a-plataforma` },
}, opPlataforma);

const tablaRutas = new aws.ec2.RouteTable("rutas", {
  vpcId: vpc.id,
  routes: [
    { cidrBlock: "0.0.0.0/0", gatewayId: igw.id },
    { cidrBlock: plataforma.cidr, vpcPeeringConnectionId: peering.id },
  ],
  tags: { Name: `${nombre}-rt` },
}, { ...opTenant, dependsOn: [aceptado] });

new aws.ec2.RouteTableAssociation("rutas-subred", { subnetId: subnet.id, routeTableId: tablaRutas.id }, opTenant);

// Ruta de vuelta: en la tabla de la PLATAFORMA, 10.N.0.0/16 va por este peering.
new aws.ec2.Route("plataforma-a-tenant", {
  routeTableId: plataforma.tabla_rutas,
  destinationCidrBlock: cidr,
  vpcPeeringConnectionId: peering.id,
}, { ...opPlataforma, dependsOn: [aceptado] });

// ---------------------------------------------------------------- firewalls

// node_exporter, process-exporter, OpenTelemetry Collector y Netdata.
const puertosAgentes = [9100, 9256, 8889, 19999];

const grupos = {} as Record<Rol, aws.ec2.SecurityGroup>;
for (const rol of roles) {
  grupos[rol] = new aws.ec2.SecurityGroup(`sg-${rol}`, {
    name: `${nombre}-sg-${rol}`,
    description: `Tenant ${slug}: ${rol}`,
    vpcId: vpc.id,
    tags: { Name: `${nombre}-sg-${rol}` },
  }, opTenant);

  // SSH (Ansible) y agentes de monitoreo, solo desde la plataforma.
  for (const puerto of [22, ...puertosAgentes]) {
    new aws.vpc.SecurityGroupIngressRule(`${rol}-${puerto}`, {
      securityGroupId: grupos[rol].id,
      description: puerto === 22 ? "SSH desde la plataforma (Ansible)" : "Monitoreo desde la plataforma",
      ipProtocol: "tcp",
      fromPort: puerto,
      toPort: puerto,
      cidrIpv4: plataforma.cidr,
    }, opTenant);
  }

  new aws.vpc.SecurityGroupEgressRule(`${rol}-salida`, {
    securityGroupId: grupos[rol].id,
    description: "Salida a internet y a la plataforma",
    ipProtocol: "-1",
    cidrIpv4: "0.0.0.0/0",
  }, opTenant);
}

new aws.vpc.SecurityGroupIngressRule("web-desde-gateway", {
  securityGroupId: grupos.frontend.id,
  description: "Web desde el gateway de la plataforma",
  ipProtocol: "tcp",
  fromPort: 80,
  toPort: 80,
  cidrIpv4: plataforma.cidr,
}, opTenant);

new aws.vpc.SecurityGroupIngressRule("api-desde-frontend", {
  securityGroupId: grupos.backend.id,
  description: "API solo desde el frontend",
  ipProtocol: "tcp",
  fromPort: 3000,
  toPort: 3000,
  referencedSecurityGroupId: grupos.frontend.id,
}, opTenant);

new aws.vpc.SecurityGroupIngressRule("base-desde-backend", {
  securityGroupId: grupos.base.id,
  description: "PostgreSQL solo desde el backend",
  ipProtocol: "tcp",
  fromPort: 5432,
  toPort: 5432,
  referencedSecurityGroupId: grupos.backend.id,
}, opTenant);

// ---------------------------------------------------------------- servidores

// Imagen: la propia más reciente (asistencia-tenant-*, de ../../packer) si existe en la
// región; si no, Amazon Linux 2023 y Ansible instala todo (más lento).
const usarImagen = config.getBoolean("usarImagen") ?? true;
const amazonLinux = aws.ssm.getParameterOutput({
  name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
}, opTenant);
const propias = aws.ec2.getAmiIdsOutput({
  owners: ["self"],
  filters: [
    { name: "name", values: ["asistencia-tenant-*"] },
    { name: "state", values: ["available"] },
  ],
}, opTenant);
// getAmiIds las devuelve de la más nueva a la más vieja.
const imagen = pulumi.all([propias.ids, amazonLinux.insecureValue])
  .apply(([ids, base]) => (usarImagen && ids.length > 0 ? ids[0] : base));

// cloud-init mínimo: solo las claves SSH. Todo lo demás lo hace Ansible.
const userData = "#cloud-config\nssh_authorized_keys:\n" +
  (plataforma.claves_ssh as string[]).map((clave) => `  - ${JSON.stringify(clave)}\n`).join("");

const servidores = {} as Record<Rol, aws.ec2.Instance>;
for (const rol of roles) {
  servidores[rol] = new aws.ec2.Instance(rol, {
    ami: imagen,
    instanceType: tamanos[rol].tipo,
    ebsOptimized: true,
    subnetId: subnet.id,
    privateIp: `10.${numero}.1.${ipFinal[rol]}`,
    vpcSecurityGroupIds: [grupos[rol].id],
    userData,
    userDataReplaceOnChange: true,
    rootBlockDevice: { volumeSize: tamanos[rol].disco, volumeType: "gp3", encrypted: true },
    metadataOptions: { httpTokens: "required" }, // IMDSv2
    // Name y Rol también los lee Prometheus (etiquetas servidor y rol).
    tags: { Name: `${slug}-${rol}`, Rol: rol },
  }, { ...opTenant, ignoreChanges: ["ami"] }); // una imagen nueva no recrea servidores existentes
}

// ---------------------------------------------------------------- salida (igual que Terraform)

// pulumi.output() espera a que existan todos los valores (ids, IPs) y los junta.
export const salida = pulumi.output({
  slug,
  region,
  plan,
  entorno,
  motor,
  numero,
  cidr,
  dominio,
  url: `http://${dominio}`,
  vpc_id: vpc.id,
  peering: peering.id,
  imagen,
  servidores: Object.fromEntries(roles.map((rol) => [rol, {
    id: servidores[rol].id,
    tipo: servidores[rol].instanceType,
    privada: servidores[rol].privateIp,
    publica: servidores[rol].publicIp,
  }])),
});

// Escribe el JSON solo en "pulumi up" (en la vista previa los valores aún no existen).
if (!pulumi.runtime.isDryRun()) {
  salida.apply((datos) => {
    const destino = path.join(infra, "generado", "tenants", `${slug}.json`);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, JSON.stringify(datos, null, 2));
  });
}

export const url = `http://${dominio}`;
