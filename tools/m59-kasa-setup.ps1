param(
  [string]$Python = 'python',
  [switch]$CredentialsOnly,
  [switch]$RuntimeOnly
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $root 'substrate/kasa-runtime'
$credentialPath = Join-Path $root 'substrate/kasa-credentials.json'
if (-not $CredentialsOnly) {
  & $Python -m venv $runtime
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the Kasa Python runtime' }
  & (Join-Path $runtime 'Scripts/python.exe') -m pip install 'python-kasa==0.12.0'
  if ($LASTEXITCODE -ne 0) { throw 'Could not install python-kasa' }
}
if (-not $RuntimeOnly) {
  $username = Read-Host 'TP-Link/Kasa account email'
  $secret = Read-Host 'TP-Link/Kasa account password (hidden)' -AsSecureString
  if (-not $username.Trim() -or $secret.Length -eq 0) { throw 'Email and password are required' }
  [IO.Directory]::CreateDirectory((Join-Path $root 'substrate')) | Out-Null
  $value = @{ username = $username.Trim(); password_dpapi = ConvertFrom-SecureString $secret }
  $value | ConvertTo-Json | Set-Content -LiteralPath $credentialPath -Encoding utf8
  $secret.Dispose()
  Write-Host 'TP-Link login saved with Windows user encryption. No password was printed.'
}
