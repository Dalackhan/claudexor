# Evidence-only scoped entry point. Requires pnpm install --frozen-lockfile in this checkout.
# It never dispatches Actions, invokes a provider CLI, or changes source files.
param([string]$Out = ".review-evidence/windows-qualification/out", [string[]]$Cases = @())
$ErrorActionPreference = "Stop"
if (-not $IsWindows) { throw "Actual Windows is mandatory" }
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$Out = if ([IO.Path]::IsPathRooted($Out)) { [IO.Path]::GetFullPath($Out) } else { [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Out)) }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$os = Get-CimInstance Win32_OperatingSystem
@{ utc = [DateTime]::UtcNow.ToString("o"); caption = $os.Caption; build = $os.BuildNumber;
   osArchitecture = $os.OSArchitecture; node = $node; nodeVersion = (& $node --version);
   imageOS = $env:ImageOS; imageVersion = $env:ImageVersion; runnerArch = $env:RUNNER_ARCH;
   runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; githubSha = $env:GITHUB_SHA;
   workflowRef = $env:GITHUB_WORKFLOW_REF; workflowSha = $env:GITHUB_WORKFLOW_SHA
} | ConvertTo-Json | Set-Content (Join-Path $Out "runner-identity.json")
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$installation = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $installation) { throw "MSVC x86/x64 tools missing" }
$devCmd = Join-Path $installation.Trim() "Common7\Tools\VsDevCmd.bat"
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("cx-win-compiler-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
  foreach ($arch in @("x64", "x86")) {
    $exe = Join-Path $Out "fixture-$arch.exe"
    $obj = Join-Path $scratch "fixture-$arch.obj"
    $cmd = Join-Path $scratch "compile-$arch.cmd"
    @"
@call "$devCmd" -no_logo -arch=$arch -host_arch=x64
@if errorlevel 1 exit /b 1
@cl.exe /nologo /W4 /WX /O2 /MT /Fe"$exe" /Fo"$obj" "$PSScriptRoot\fixture.c" /link /SUBSYSTEM:CONSOLE
@exit /b %errorlevel%
"@ | Set-Content -LiteralPath $cmd -Encoding ascii
    & $env:ComSpec /d /s /c "`"$cmd`"" 2>&1 | Tee-Object -FilePath (Join-Path $Out "compile-$arch.log")
    if ($LASTEXITCODE -ne 0) { throw "fixture $arch compilation failed: $LASTEXITCODE" }
  }
  Push-Location $repo
  try {
    & $node (Join-Path $PSScriptRoot "build.mjs") $repo $Out
    if ($LASTEXITCODE -ne 0) { throw "source bundle failed: $LASTEXITCODE" }
    & $node (Join-Path $PSScriptRoot "run.mjs") $Out @Cases
    if ($LASTEXITCODE -ne 0) { throw "qualification failed: $LASTEXITCODE; inspect summary.json and per-case result.json" }
  } finally { Pop-Location }
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
