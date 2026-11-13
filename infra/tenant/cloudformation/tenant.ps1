# Crea o borra un tenant con CloudFormation. Son dos stacks:
#   tenant-<slug>        en la región del tenant: red, peering y 3 servidores (tenant.yaml)
#   tenant-<slug>-ruta   en la región de la plataforma: la ruta de vuelta (ruta-plataforma.yaml)
#
# Al crear, escribe ..\..\generado\tenants\<slug>.json con el mismo formato que
# Terraform y Pulumi. Después sigue igual que con los otros motores (inventario.py + tenant.yml).
#
# Uso (PowerShell, desde cualquier carpeta):
#   .\infra\tenant\cloudformation\tenant.ps1 -Accion crear  -Slug la-salle -Numero 2 -Region us-west-2 -Plan basico
#   .\infra\tenant\cloudformation\tenant.ps1 -Accion borrar -Slug la-salle -Region us-west-2
#
# Si PowerShell no deja ejecutarlo:  Unblock-File .\infra\tenant\cloudformation\tenant.ps1

param(
    [Parameter(Mandatory)][ValidateSet('crear', 'borrar')][string]$Accion,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]+(-[a-z0-9]+)*$')][ValidateLength(3, 30)][string]$Slug,
    [ValidateRange(0, 250)][int]$Numero = 0,
    [ValidateSet('us-east-1', 'us-east-2', 'us-west-2')][string]$Region = 'us-east-2',
    [ValidateSet('basico', 'estandar', 'avanzado')][string]$Plan = 'basico',
    [ValidateSet('production', 'staging')][string]$Entorno = 'production',
    [string]$Profile = ''
)
$ErrorActionPreference = 'Stop'

$aqui       = $PSScriptRoot
$infra      = (Resolve-Path (Join-Path $aqui '..\..')).Path
$salida     = Join-Path $infra "generado\tenants\$Slug.json"
$stack      = "tenant-$Slug"
$stackRuta  = "tenant-$Slug-ruta"
$perfil     = @()
if ($Profile) { $perfil = @('--profile', $Profile) }

$archivoPlataforma = Join-Path $infra 'generado\plataforma.json'
if (-not (Test-Path $archivoPlataforma)) { throw "No existe $archivoPlataforma. Primero crea la plataforma (infra\plataforma)." }
$plataforma = Get-Content $archivoPlataforma -Raw -Encoding UTF8 | ConvertFrom-Json

# Ejecuta el AWS CLI y se detiene si falla.
function Invoke-Aws {
    $salidaAws = & aws @args @perfil
    if ($LASTEXITCODE -ne 0) { throw "Falló: aws $($args -join ' ')" }
    return $salidaAws
}

# Las mismas etiquetas que Terraform y Pulumi: CloudFormation las copia a cada recurso.
$etiquetas = @(
    'Proyecto=asistencia', "Tenant=$Slug", "Plan=$Plan", "Entorno=$Entorno",
    'Motor=cloudformation', 'GestionadoPor=cloudformation'
)

if ($Accion -eq 'crear') {
    if ($Numero -lt 1) { throw 'Falta -Numero (1 a 250): la red del tenant será 10.<Numero>.0.0/16.' }

    $parametros = @(
        "Slug=$Slug", "Numero=$Numero", "Plan=$Plan",
        "PlataformaVpc=$($plataforma.vpc_id)", "PlataformaCidr=$($plataforma.cidr)",
        "PlataformaRegion=$($plataforma.region)", "ClavesSsh=$($plataforma.claves_ssh -join ',')"
    )

    # Imagen propia de Packer, solo al CREAR el stack: si ya existe se deja la que tiene
    # (cambiar la imagen recrearía los servidores y se perderían los datos).
    & aws cloudformation describe-stacks --region $Region --stack-name $stack @perfil *> $null
    if ($LASTEXITCODE -ne 0) {
        $imagen = (Invoke-Aws ec2 describe-images --region $Region --owners self `
            --filters 'Name=name,Values=asistencia-tenant-*' 'Name=state,Values=available' `
            --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text | Out-String).Trim()
        if ($imagen -match '^ami-') {
            Write-Host "Imagen propia (Packer): $imagen"
            $parametros += "ImagenPropia=$imagen"
        }
        else {
            Write-Host 'Sin imagen propia en esta región: Amazon Linux 2023 (Ansible instala todo).'
        }
    }

    # 1. Red, peering y servidores, en la región del tenant.
    Write-Host "1/3  Stack $stack en $Region (5-8 minutos)..."
    Invoke-Aws cloudformation deploy --region $Region --stack-name $stack `
        --template-file (Join-Path $aqui 'tenant.yaml') `
        --parameter-overrides @parametros `
        --tags @etiquetas --no-fail-on-empty-changeset | Out-Host

    $valores = @{}
    (Invoke-Aws cloudformation describe-stacks --region $Region --stack-name $stack `
        --query 'Stacks[0].Outputs' --output json | Out-String | ConvertFrom-Json) |
        ForEach-Object { $valores[$_.OutputKey] = $_.OutputValue }

    # 2. Ruta de vuelta, en la región de la plataforma.
    Write-Host "2/3  Stack $stackRuta en $($plataforma.region)..."
    Invoke-Aws cloudformation deploy --region $plataforma.region --stack-name $stackRuta `
        --template-file (Join-Path $aqui 'ruta-plataforma.yaml') `
        --parameter-overrides "TablaRutas=$($plataforma.tabla_rutas)" "CidrTenant=10.$Numero.0.0/16" `
            "Peering=$($valores.Peering)" `
        --tags @etiquetas --no-fail-on-empty-changeset | Out-Host

    # 3. La misma salida que Terraform y Pulumi.
    $dominio = "$Slug.$($plataforma.dominio)"
    $datos = [ordered]@{
        slug       = $Slug
        region     = $Region
        plan       = $Plan
        entorno    = $Entorno
        motor      = 'cloudformation'
        numero     = $Numero
        cidr       = "10.$Numero.0.0/16"
        dominio    = $dominio
        url        = "http://$dominio"
        vpc_id     = $valores.VpcId
        peering    = $valores.Peering
        imagen     = $valores.Imagen
        servidores = [ordered]@{}
    }
    foreach ($rol in 'frontend', 'backend', 'base') {
        $clave = (Get-Culture).TextInfo.ToTitleCase($rol) # frontend -> Frontend
        $datos.servidores[$rol] = [ordered]@{
            id      = $valores["${clave}Id"]
            tipo    = $valores["${clave}Tipo"]
            privada = $valores["${clave}Privada"]
            publica = $valores["${clave}Publica"]
        }
    }
    New-Item -ItemType Directory -Force (Split-Path $salida) | Out-Null
    # UTF-8 sin BOM (PowerShell 5 agrega BOM con -Encoding UTF8).
    [System.IO.File]::WriteAllText($salida, ($datos | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))

    Write-Host "3/3  Listo: $salida"
    Write-Host ''
    Write-Host 'Ahora, en WSL (carpeta infra):'
    Write-Host "  python3 scripts/inventario.py $Slug"
    Write-Host "  cd ansible && ansible-playbook -i inventarios/$Slug.ini tenant.yml"
}
else {
    # Al revés: primero la ruta (usa el peering), luego el tenant.
    Write-Host "1/2  Borrando $stackRuta en $($plataforma.region)..."
    Invoke-Aws cloudformation delete-stack --region $plataforma.region --stack-name $stackRuta | Out-Host
    Invoke-Aws cloudformation wait stack-delete-complete --region $plataforma.region --stack-name $stackRuta | Out-Host

    Write-Host "2/2  Borrando $stack en $Region (3-5 minutos)..."
    Invoke-Aws cloudformation delete-stack --region $Region --stack-name $stack | Out-Host
    Invoke-Aws cloudformation wait stack-delete-complete --region $Region --stack-name $stack | Out-Host

    Remove-Item $salida -ErrorAction SilentlyContinue
    Write-Host "Listo: el tenant $Slug ya no existe. Quita su ruta del gateway (ver LEEME.md)."
}
