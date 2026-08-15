[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$ProxyUri,

  [switch]$NoProxy,

  [switch]$Build,

  [switch]$InstallPowerShell,

  [switch]$DeclinePowerShellInstall,

  [Parameter(DontShow = $true)]
  [version]$BootstrapCurrentVersion,

  [Parameter(DontShow = $true)]
  [AllowEmptyString()]
  [string]$BootstrapPowerShellCommand,

  [Parameter(DontShow = $true)]
  [AllowEmptyString()]
  [string]$BootstrapWingetCommand,

  [Parameter(DontShow = $true)]
  [string]$BootstrapHostLauncherPath,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$DshArguments
)

$ErrorActionPreference = 'Stop'
$minimumPowerShellVersion = [version]'7.0.0'
$manualInstallUrl = 'https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows'

$testParameters = @(
  'BootstrapCurrentVersion',
  'BootstrapPowerShellCommand',
  'BootstrapWingetCommand',
  'BootstrapHostLauncherPath'
)
$usesTestParameter = $false
foreach ($name in $testParameters) {
  if ($PSBoundParameters.ContainsKey($name)) {
    $usesTestParameter = $true
    break
  }
}
if ($usesTestParameter -and $env:SAKI_BOOTSTRAP_TEST_MODE -ne '1') {
  throw 'Bootstrap dependency overrides are reserved for Saki verification.'
}

if ($InstallPowerShell -and $DeclinePowerShellInstall) {
  throw 'Use either -InstallPowerShell or -DeclinePowerShellInstall, not both.'
}

if (-not $PSBoundParameters.ContainsKey('BootstrapCurrentVersion')) {
  $BootstrapCurrentVersion = $PSVersionTable.PSVersion
}
if (-not $PSBoundParameters.ContainsKey('BootstrapPowerShellCommand')) {
  $BootstrapPowerShellCommand = 'pwsh'
}
if (-not $PSBoundParameters.ContainsKey('BootstrapWingetCommand')) {
  $BootstrapWingetCommand = 'winget'
}
if (-not $PSBoundParameters.ContainsKey('BootstrapHostLauncherPath')) {
  $BootstrapHostLauncherPath = Join-Path $PSScriptRoot 'start-saki-host.ps1'
}
$proxyWasSpecified = $PSBoundParameters.ContainsKey('ProxyUri')

function Resolve-SakiCommandPath {
  param(
    [AllowEmptyString()]
    [string]$CommandName
  )

  if ([string]::IsNullOrWhiteSpace($CommandName)) {
    return $null
  }

  $command = Get-Command -Name $CommandName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) {
    return $null
  }
  if (-not [string]::IsNullOrWhiteSpace($command.Path)) {
    return $command.Path
  }
  if (-not [string]::IsNullOrWhiteSpace($command.Source)) {
    return $command.Source
  }
  return $command.Name
}

function Get-SakiPowerShellVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PowerShellPath
  )

  $versionOutput = & $PowerShellPath -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    return $null
  }

  $versionText = [string]($versionOutput | Select-Object -Last 1)
  if ([string]::IsNullOrWhiteSpace($versionText)) {
    return $null
  }
  $parsedVersion = $null
  if ([version]::TryParse($versionText.Trim(), [ref]$parsedVersion)) {
    return $parsedVersion
  }
  return $null
}

function Get-SakiLauncherArgumentTokens {
  $tokens = @()
  if ($proxyWasSpecified) {
    $tokens += '-ProxyUri'
    $tokens += $ProxyUri
  }
  if ($NoProxy) {
    $tokens += '-NoProxy'
  }
  if ($Build) {
    $tokens += '-Build'
  }
  if ($null -ne $DshArguments -and $DshArguments.Count -gt 0) {
    $tokens += $DshArguments
  }
  return $tokens
}

function Invoke-SakiHostInCurrentPowerShell {
  $launcherParameters = @{}
  if ($proxyWasSpecified) {
    $launcherParameters['ProxyUri'] = $ProxyUri
  }
  if ($NoProxy) {
    $launcherParameters['NoProxy'] = $true
  }
  if ($Build) {
    $launcherParameters['Build'] = $true
  }
  if ($null -ne $DshArguments -and $DshArguments.Count -gt 0) {
    $launcherParameters['DshArguments'] = $DshArguments
  }

  & $BootstrapHostLauncherPath @launcherParameters
}

function Invoke-SakiHostInPowerShell {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PowerShellPath
  )

  $launcherArguments = Get-SakiLauncherArgumentTokens
  & $PowerShellPath -NoLogo -NoProfile -File $BootstrapHostLauncherPath @launcherArguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Saki PowerShell 7 host exited with code $exitCode."
  }
}

Write-Host "Detected PowerShell $BootstrapCurrentVersion."
if ($BootstrapCurrentVersion -ge $minimumPowerShellVersion) {
  Invoke-SakiHostInCurrentPowerShell
  return
}

$powerShellPath = Resolve-SakiCommandPath -CommandName $BootstrapPowerShellCommand
$installedPowerShellVersion = $null
if ($null -ne $powerShellPath) {
  $installedPowerShellVersion = Get-SakiPowerShellVersion -PowerShellPath $powerShellPath
}

if ($null -ne $installedPowerShellVersion -and $installedPowerShellVersion -ge $minimumPowerShellVersion) {
  Write-Host "Using PowerShell $installedPowerShellVersion at $powerShellPath."
  Invoke-SakiHostInPowerShell -PowerShellPath $powerShellPath
  return
}

if ($DeclinePowerShellInstall) {
  throw "PowerShell 7 installation was declined. Install it manually and retry: $manualInstallUrl"
}

$consentGranted = $InstallPowerShell
if (-not $consentGranted) {
  $answer = Read-Host 'Saki requires PowerShell 7. Install or upgrade it with winget now? [y/N]'
  $consentGranted = $answer -match '^(?i:y|yes)$'
}
if (-not $consentGranted) {
  throw "PowerShell 7 installation was declined. Install it manually and retry: $manualInstallUrl"
}

$wingetPath = Resolve-SakiCommandPath -CommandName $BootstrapWingetCommand
if ($null -eq $wingetPath) {
  throw "winget is unavailable. Install PowerShell 7 manually and retry: $manualInstallUrl"
}

$wingetOperation = 'install'
if ($null -ne $powerShellPath) {
  $wingetOperation = 'upgrade'
}
Write-Host "Running winget $wingetOperation for Microsoft.PowerShell after explicit consent."
& $wingetPath $wingetOperation --id Microsoft.PowerShell --exact --source winget --accept-package-agreements --accept-source-agreements
$wingetExitCode = $LASTEXITCODE
if ($wingetExitCode -ne 0) {
  throw "winget failed with exit code $wingetExitCode. Install PowerShell 7 manually and retry: $manualInstallUrl"
}

$powerShellPath = Resolve-SakiCommandPath -CommandName $BootstrapPowerShellCommand
if ($null -eq $powerShellPath) {
  $defaultPowerShellPath = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
  if (Test-Path -LiteralPath $defaultPowerShellPath -PathType Leaf) {
    $powerShellPath = $defaultPowerShellPath
  }
}
if ($null -eq $powerShellPath) {
  throw "PowerShell 7 was installed but pwsh is not visible yet. Open a new terminal and retry. Manual instructions: $manualInstallUrl"
}

$installedPowerShellVersion = Get-SakiPowerShellVersion -PowerShellPath $powerShellPath
if ($null -eq $installedPowerShellVersion -or $installedPowerShellVersion -lt $minimumPowerShellVersion) {
  throw "PowerShell 7 installation did not produce a supported pwsh runtime. Open a new terminal or install it manually: $manualInstallUrl"
}

Write-Host "PowerShell $installedPowerShellVersion is ready at $powerShellPath."
Invoke-SakiHostInPowerShell -PowerShellPath $powerShellPath
