param(
  [ValidateSet('codeql', 'semgrep', 'gitleaks', 'trivy', 'all')]
  [string]$Tool = 'all',
  [switch]$DownloadOnly
)

$ErrorActionPreference = 'Stop'
$packages = @{
  codeql = 'GitHub.CodeQL'
  semgrep = 'Semgrep.Semgrep'
  gitleaks = 'Gitleaks.Gitleaks'
  trivy = 'AquaSecurity.Trivy'
}
$executables = @{
  codeql = 'codeql.exe'
  semgrep = 'semgrep.exe'
  gitleaks = 'gitleaks.exe'
  trivy = 'trivy.exe'
}
$requested = if ($Tool -eq 'all') { @('codeql', 'semgrep', 'gitleaks', 'trivy') } else { @($Tool) }
$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
if (-not $winget) {
  Write-Output (@{ status = 'BLOCKED'; reason = 'winget.exe is not installed. Install App Installer from Microsoft Store, then rerun this script.'; tools = $requested } | ConvertTo-Json -Compress)
  exit 2
}

$results = @()
foreach ($name in $requested) {
  $exe = Get-Command $executables[$name] -ErrorAction SilentlyContinue
  if ($exe) {
    $results += @{ tool = $name; status = 'ALREADY_INSTALLED'; executable = $exe.Source }
    continue
  }
  if ($DownloadOnly) {
    $results += @{ tool = $name; status = 'READY_TO_DOWNLOAD'; packageId = $packages[$name] }
    continue
  }
  & $winget.Source install --id $packages[$name] --exact --source winget --accept-package-agreements --accept-source-agreements --silent
  $exitCode = $LASTEXITCODE
  $installed = Get-Command $executables[$name] -ErrorAction SilentlyContinue
  $installedPath = if ($installed) { $installed.Source } else { $null }
  $results += @{ tool = $name; status = if ($installed) { 'INSTALLED' } elseif ($exitCode -eq 0) { 'INSTALLED_RESTART_PATH' } else { 'FAILED' }; exitCode = $exitCode; executable = $installedPath; packageId = $packages[$name] }
}
Write-Output (@{ status = if (($results | Where-Object { $_.status -eq 'FAILED' }).Count) { 'PARTIAL' } else { 'PASS' }; results = $results; nextStep = 'Restart NEXUS or refresh PATH, then call GET /api/autonomy/security/tools.' } | ConvertTo-Json -Depth 5)
