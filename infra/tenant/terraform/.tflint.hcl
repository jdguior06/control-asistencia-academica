# TFLint (paso 2 de scripts/aprovisionar.sh): reglas recomendadas de Terraform.
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
