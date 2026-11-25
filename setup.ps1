# Windows 一键安装：没有 Node 24 时自动下载便携版，然后运行 install.mjs。
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location -Path (Split-Path -Parent $MyInvocation.MyCommand.Path)

$minMajor = 24
$version = if ($env:VOLC_USAGE_NODE_VERSION) { $env:VOLC_USAGE_NODE_VERSION } else { '24.22.2' }

function Get-NodeMajor([string]$exe) {
  try {
    $value = & $exe -p "process.versions.node.split('.')[0]" 2>$null
    return [int]$value
  } catch {
    return 0
  }
}

$systemNode = Get-Command node -ErrorAction SilentlyContinue
if ($systemNode -and (Get-NodeMajor $systemNode.Source) -ge $minMajor) {
  & node install.mjs @args
  exit $LASTEXITCODE
}

$portable = Join-Path (Get-Location) '.runtime\node\node.exe'
if ((Test-Path $portable) -and (Get-NodeMajor $portable) -ge $minMajor) {
  & $portable install.mjs @args
  exit $LASTEXITCODE
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$name = "node-v$version-$arch"
$archive = Join-Path '.runtime' "$name.zip"

New-Item -ItemType Directory -Force '.runtime' | Out-Null
Write-Host "未找到 Node.js $minMajor+，正在下载便携版 $version（$arch）…"

Invoke-WebRequest -Uri "https://nodejs.org/dist/v$version/$name.zip" -OutFile $archive -UseBasicParsing

try {
  $sums = Invoke-WebRequest -Uri "https://nodejs.org/dist/v$version/SHASUMS256.txt" -UseBasicParsing
  $line = ($sums.Content -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($name)).zip$" } | Select-Object -First 1)
  if ($line) {
    $expected = $line.Trim().Split()[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLower()
    if ($actual -ne $expected) { throw 'Node.js 安装包校验失败' }
  }
} catch {
  Write-Warning "跳过校验：$($_.Exception.Message)"
}

Expand-Archive -Path $archive -DestinationPath '.runtime' -Force
if (Test-Path '.runtime\node') { Remove-Item '.runtime\node' -Recurse -Force }
Move-Item ".runtime\$name" '.runtime\node'
Remove-Item $archive -Force

& '.runtime\node\node.exe' install.mjs @args
exit $LASTEXITCODE
