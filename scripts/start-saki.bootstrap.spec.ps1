#Requires -Version 7.0

$ErrorActionPreference = 'Stop'
$entryPoint = Join-Path $PSScriptRoot 'start-saki.ps1'
$hostLauncher = Join-Path $PSScriptRoot 'start-saki-host.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("saki-pwsh-bootstrap-{0}" -f [guid]::NewGuid())
$pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
$windowsPowerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source

function Assert-SakiBootstrap {
  param(
    [Parameter(Mandatory = $true)]
    [bool]$Condition,

    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Invoke-SakiBootstrapProcess {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string[]]$Arguments,

    [hashtable]$Environment = @{},

    [string]$PowerShellExecutable = $pwshPath
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $PowerShellExecutable
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $entryPoint) + $Arguments) {
    [void]$startInfo.ArgumentList.Add($argument)
  }
  $startInfo.Environment['SAKI_BOOTSTRAP_TEST_MODE'] = '1'
  foreach ($entry in $Environment.GetEnumerator()) {
    $startInfo.Environment[[string]$entry.Key] = [string]$entry.Value
  }

  $process = [System.Diagnostics.Process]::Start($startInfo)
  $standardOutput = $process.StandardOutput.ReadToEnd()
  $standardError = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    Output = $standardOutput + $standardError
  }
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  $hostLauncherFirstLine = Get-Content -LiteralPath $hostLauncher -TotalCount 1
  Assert-SakiBootstrap ($hostLauncherFirstLine -eq '#Requires -Version 7.0') 'The ordinary Saki host must declare PowerShell 7.'

  $hostResultPath = Join-Path $testRoot 'host-result.json'
  $fakeHostPath = Join-Path $testRoot 'fake-host.ps1'
  @'
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$ProxyUri,
  [switch]$NoProxy,
  [switch]$Build,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$DshArguments
)
[ordered]@{
  ProxyUri = $ProxyUri
  NoProxy = $NoProxy.IsPresent
  Build = $Build.IsPresent
  DshArguments = @($DshArguments)
} | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:SAKI_BOOTSTRAP_TEST_HOST_RESULT
'@ | Set-Content -LiteralPath $fakeHostPath

  $present = Invoke-SakiBootstrapProcess -Arguments @(
    '-ProxyUri', 'http://127.0.0.1:7897',
    '-Build',
    '-BootstrapCurrentVersion', '7.4.1',
    '-BootstrapHostLauncherPath', $fakeHostPath,
    'web', '--port', '3081'
  ) -Environment @{ SAKI_BOOTSTRAP_TEST_HOST_RESULT = $hostResultPath }
  Assert-SakiBootstrap ($present.ExitCode -eq 0) "runtime-present scenario failed: $($present.Output)"
  $hostResult = Get-Content -LiteralPath $hostResultPath -Raw | ConvertFrom-Json
  Assert-SakiBootstrap ($hostResult.ProxyUri -eq 'http://127.0.0.1:7897') 'runtime-present scenario lost ProxyUri.'
  Assert-SakiBootstrap ($hostResult.Build -eq $true) 'runtime-present scenario lost Build.'
  Assert-SakiBootstrap (($hostResult.DshArguments -join '|') -eq 'web|--port|3081') 'runtime-present scenario lost DSH arguments.'

  $declined = Invoke-SakiBootstrapProcess -Arguments @(
    '-BootstrapCurrentVersion', '5.1',
    '-BootstrapPowerShellCommand', '',
    '-DeclinePowerShellInstall'
  )
  Assert-SakiBootstrap ($declined.ExitCode -ne 0) 'declined-install scenario unexpectedly succeeded.'
  Assert-SakiBootstrap ($declined.Output -match 'installation was declined') 'declined-install scenario was not actionable.'

  $failedWingetPath = Join-Path $testRoot 'winget-failure.cmd'
  "@echo off`r`nexit /b 42`r`n" | Set-Content -LiteralPath $failedWingetPath -NoNewline
  $installFailure = Invoke-SakiBootstrapProcess -Arguments @(
    '-BootstrapCurrentVersion', '5.1',
    '-BootstrapPowerShellCommand', '',
    '-BootstrapWingetCommand', $failedWingetPath,
    '-InstallPowerShell'
  )
  Assert-SakiBootstrap ($installFailure.ExitCode -ne 0) 'install-failure scenario unexpectedly succeeded.'
  Assert-SakiBootstrap ($installFailure.Output -match 'winget failed with exit code 42') 'install-failure scenario did not report the winget exit code.'

  $fakePwshPath = Join-Path $testRoot 'pwsh.cmd'
  $fakePwshTemplate = Join-Path $testRoot 'pwsh-template.cmd'
  $relaunchPath = Join-Path $testRoot 'relaunch.txt'
  @'
@echo off
if /I "%~4"=="-Command" (
  echo 7.4.2
  exit /b 0
)
>"%SAKI_BOOTSTRAP_TEST_RELAUNCH%" echo %*
exit /b 0
'@ | Set-Content -LiteralPath $fakePwshTemplate
  $successfulWingetPath = Join-Path $testRoot 'winget-success.cmd'
  @'
@echo off
copy /Y "%SAKI_BOOTSTRAP_TEST_PWSH_TEMPLATE%" "%SAKI_BOOTSTRAP_TEST_PWSH_TARGET%" >nul
exit /b 0
'@ | Set-Content -LiteralPath $successfulWingetPath

  $installed = Invoke-SakiBootstrapProcess -Arguments @(
    '-ProxyUri', 'http://127.0.0.1:7897',
    '-Build',
    '-BootstrapCurrentVersion', '5.1',
    '-BootstrapPowerShellCommand', $fakePwshPath,
    '-BootstrapWingetCommand', $successfulWingetPath,
    '-BootstrapHostLauncherPath', 'C:\Saki test\start-saki-host.ps1',
    '-InstallPowerShell',
    'web', '--port', '3081'
  ) -Environment @{
    SAKI_BOOTSTRAP_TEST_PWSH_TEMPLATE = $fakePwshTemplate
    SAKI_BOOTSTRAP_TEST_PWSH_TARGET = $fakePwshPath
    SAKI_BOOTSTRAP_TEST_RELAUNCH = $relaunchPath
  }
  Assert-SakiBootstrap ($installed.ExitCode -eq 0) "runtime-missing install scenario failed: $($installed.Output)"
  Assert-SakiBootstrap ($installed.Output -match 'PowerShell 7.4.2 is ready') 'runtime-missing scenario did not report the resulting version.'
  $relaunch = Get-Content -LiteralPath $relaunchPath -Raw
  Assert-SakiBootstrap ($relaunch -match '-File "?C:\\Saki test\\start-saki-host.ps1"?') 'runtime-missing scenario did not relaunch the PowerShell 7 host.'
  Assert-SakiBootstrap ($relaunch -match '-ProxyUri http://127.0.0.1:7897') 'runtime-missing scenario lost ProxyUri during relaunch.'
  Assert-SakiBootstrap ($relaunch -match '-Build') 'runtime-missing scenario lost Build during relaunch.'
  Assert-SakiBootstrap ($relaunch -match 'web --port 3081') 'runtime-missing scenario lost DSH arguments during relaunch.'

  Remove-Item -LiteralPath $relaunchPath
  $windowsPowerShell = Invoke-SakiBootstrapProcess -PowerShellExecutable $windowsPowerShellPath -Arguments @(
    '-BootstrapPowerShellCommand', $fakePwshPath,
    '-BootstrapHostLauncherPath', 'C:\Saki test\start-saki-host.ps1',
    'web', '--port', '3081'
  ) -Environment @{ SAKI_BOOTSTRAP_TEST_RELAUNCH = $relaunchPath }
  Assert-SakiBootstrap ($windowsPowerShell.ExitCode -eq 0) "Windows PowerShell 5.1 compatibility scenario failed: $($windowsPowerShell.Output)"
  Assert-SakiBootstrap ($windowsPowerShell.Output -match 'Detected PowerShell 5\.1') 'Windows PowerShell 5.1 was not detected and reported.'
  Assert-SakiBootstrap (Test-Path -LiteralPath $relaunchPath) 'Windows PowerShell 5.1 did not relaunch through pwsh.'

  Write-Host 'Saki PowerShell bootstrap verification passed.'
}
finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
