#Requires -Version 7.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$entrypoint = Join-Path $repoRoot 'packages/saki/installation-maintenance/src/bin.ts'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1

if ($null -eq $nodeCommand) {
  [Console]::Error.WriteLine('node is not available on PATH. Install Node or add it to PATH and retry.')
  exit 1
}

Push-Location $repoRoot
try {
  $LASTEXITCODE = $null
  try {
    & $nodeCommand.Path --import tsx/esm $entrypoint @args
    $maintenanceExitCode = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }
  }
  catch {
    [Console]::Error.WriteLine('node was found on PATH but could not be started. Repair the Node installation and retry.')
    $maintenanceExitCode = 1
  }
}
finally {
  Pop-Location
}
exit $maintenanceExitCode
