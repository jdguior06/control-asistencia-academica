export type Provider = 'aws' | 'azure'

// Las 3 regiones de AWS que permite la organización de la cuenta (2 instituciones por
// región, por la cuota de vCPU). Azure se muestra, pero todavía no se puede elegir.
export const providers = [
  { value: 'aws', label: 'AWS', disabled: false },
  { value: 'azure', label: 'Azure (próximamente)', disabled: true },
] satisfies { value: Provider; label: string; disabled: boolean }[]

export const regions = [
  { value: 'us-east-2', label: 'Ohio · AWS', provider: 'aws', disabled: false },
  { value: 'us-east-1', label: 'Virginia del Norte · AWS', provider: 'aws', disabled: false },
  { value: 'us-west-2', label: 'Oregón · AWS', provider: 'aws', disabled: false },
  { value: 'eastus', label: 'Este de EE. UU. · Azure (próximamente)', provider: 'azure', disabled: true },
] satisfies { value: string; label: string; provider: Provider; disabled: boolean }[]

export const environments = [
  { value: 'production', label: 'Producción' },
  { value: 'staging', label: 'Pruebas' },
]

export const engines = [
  { value: 'terraform', label: 'Terraform' },
  { value: 'opentofu', label: 'OpenTofu' },
  { value: 'pulumi', label: 'Pulumi' },
  { value: 'cloudformation', label: 'CloudFormation' },
]

export function slugFromName(name: string) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '')
}

export function optionLabel(options: { value: string; label: string }[], value: string) {
  return options.find(option => option.value === value)?.label ?? value
}
