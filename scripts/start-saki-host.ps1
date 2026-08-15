#Requires -Version 7.0

[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$ProxyUri,

  [switch]$NoProxy,

  [switch]$Build,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$DshArguments
)

$ErrorActionPreference = 'Stop'

if ($NoProxy -and $PSBoundParameters.ContainsKey('ProxyUri')) {
  throw 'Use either -NoProxy or -ProxyUri, not both.'
}

if (-not $NoProxy -and -not $PSBoundParameters.ContainsKey('ProxyUri')) {
  $ProxyUri = $env:SAKI_PROXY_URI
}

if (-not $NoProxy -and [string]::IsNullOrWhiteSpace($ProxyUri)) {
  $ProxyUri = 'http://127.0.0.1:7897'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Join-Path $repoRoot 'package.json'
if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
  throw "Saki repository root not found at $repoRoot."
}

if ($null -eq (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'pnpm is not available on PATH. Open a new PowerShell session after installing Node and pnpm.'
}

$proxyVariableNames = @(
  'NODE_USE_ENV_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy'
)
$previousEnvironment = @{}
foreach ($name in $proxyVariableNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable(
    $name,
    [EnvironmentVariableTarget]::Process
  )
}

function Set-ProcessEnvironmentVariable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [AllowNull()]
    [object]$Value
  )

  if ($null -eq $Value) {
    Remove-Item -LiteralPath "Env:\$Name" -ErrorAction SilentlyContinue
  }
  else {
    [Environment]::SetEnvironmentVariable(
      $Name,
      [string]$Value,
      [EnvironmentVariableTarget]::Process
    )
  }
}

try {
  if ($NoProxy) {
    foreach ($name in $proxyVariableNames) {
      Set-ProcessEnvironmentVariable -Name $name -Value $null
    }
  }
  else {
    try {
      $parsedProxyUri = [Uri]$ProxyUri
    }
    catch {
      throw "Invalid proxy URI: $ProxyUri"
    }

    if (-not $parsedProxyUri.IsAbsoluteUri -or $parsedProxyUri.Scheme -notin @('http', 'https')) {
      throw "Proxy URI must use http or https: $ProxyUri"
    }

    $proxyClient = [System.Net.Sockets.TcpClient]::new()
    try {
      $connection = $proxyClient.BeginConnect($parsedProxyUri.Host, $parsedProxyUri.Port, $null, $null)
      if (-not $connection.AsyncWaitHandle.WaitOne(2000)) {
        throw "Proxy did not accept a connection within 2 seconds: $ProxyUri"
      }
      $proxyClient.EndConnect($connection)
    }
    catch {
      throw "Proxy is unavailable at $ProxyUri. Start Clash or pass -NoProxy. $($_.Exception.Message)"
    }
    finally {
      $proxyClient.Dispose()
    }

    $existingNoProxy = $previousEnvironment['NO_PROXY']
    if ([string]::IsNullOrWhiteSpace($existingNoProxy)) {
      $existingNoProxy = $previousEnvironment['no_proxy']
    }
    $noProxyEntries = @('localhost', '127.0.0.1', '::1')
    if (-not [string]::IsNullOrWhiteSpace($existingNoProxy)) {
      $noProxyEntries += $existingNoProxy.Split(',')
    }
    $noProxyList = ($noProxyEntries | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique) -join ','

    Set-ProcessEnvironmentVariable -Name 'NODE_USE_ENV_PROXY' -Value '1'
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
      Set-ProcessEnvironmentVariable -Name $name -Value $ProxyUri
    }
    Set-ProcessEnvironmentVariable -Name 'NO_PROXY' -Value $noProxyList
    Set-ProcessEnvironmentVariable -Name 'no_proxy' -Value $noProxyList
  }

  Push-Location $repoRoot
  try {
    if ($Build) {
      & pnpm run build
      if ($LASTEXITCODE -ne 0) {
        throw "Saki build failed with exit code $LASTEXITCODE."
      }
    }

    if ($DshArguments.Count -eq 0) {
      $DshArguments = @('web')
    }

    & pnpm dsh @DshArguments
    $dshExitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
}
finally {
  foreach ($name in $proxyVariableNames) {
    Set-ProcessEnvironmentVariable -Name $name -Value $previousEnvironment[$name]
  }
}

if ($dshExitCode -ne 0) {
  throw "Saki exited with code $dshExitCode."
}
