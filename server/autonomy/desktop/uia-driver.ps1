# PROJECT NEXUS - Windows UI Automation driver for desktop AI clients.
#
# Design constraints (directive 6.1):
#   * Locate windows by process name / title / class, NEVER by fixed screen coords.
#   * Locate controls by AutomationId / Name / ControlType, NEVER by coordinate.
#   * If the expected control is missing, return CONTROL_NOT_FOUND and STOP.
#     The caller must never "click around" hoping to hit the right target.
#   * Screenshots are taken from the window's own bounding rectangle.
#
# All output is a single compact JSON object on stdout.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('probe', 'windows', 'find', 'set-value', 'invoke', 'read-text', 'screenshot')]
  [string]$Action,
  [string]$WindowMatch = '',
  [string]$ProcessName = '',
  [string]$ControlName = '',
  [string]$AutomationId = '',
  [string]$ControlType = '',
  [string]$Value = '',
  [string]$ValueFile = '',
  [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
# Keep window titles readable when they contain non-ASCII characters.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result($object) {
  $object | ConvertTo-Json -Depth 6 -Compress
}

function Load-Uia {
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

if ($Action -eq 'probe') {
  $available = Load-Uia
  $diagnostics = $null
  if ($available) {
    try {
      $rootElement = [System.Windows.Automation.AutomationElement]::RootElement
      $childCount = $rootElement.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition).Count
      $diagnostics = @{
        apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString()
        rootName = $rootElement.Current.Name
        rootChildren = $childCount
        sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        interactive = [System.Environment]::UserInteractive
      }
    } catch {
      $diagnostics = @{ error = $_.Exception.Message }
    }
  }
  Write-Result @{
    ok = $true
    action = 'probe'
    uiaAvailable = $available
    platform = [System.Environment]::OSVersion.VersionString
    diagnostics = $diagnostics
    note = if ($available) { 'UIAutomationClient loaded from GAC' } else { 'UIAutomationClient unavailable in this session' }
  }
  exit 0
}

if (-not (Load-Uia)) {
  Write-Result @{ ok = $false; code = 'UIA_UNAVAILABLE'; message = 'UIAutomationClient could not be loaded.' }
  exit 2
}

$AE = [System.Windows.Automation.AutomationElement]
$TreeScope = [System.Windows.Automation.TreeScope]
$ControlTypeClass = [System.Windows.Automation.ControlType]

function ConvertTo-FiniteInt($value) {
  # A minimized/off-screen window reports +/-Infinity. ConvertTo-Json would
  # emit a bare Infinity token, which is not valid JSON and breaks the driver.
  try {
    $number = [double]$value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return 0 }
    return [int]$number
  } catch { return 0 }
}

function Get-WindowInventory {
  $root = $AE::RootElement
  # Some Windows builds expose top-level frames as Pane/Group rather than the
  # Window control type, so enumerate all desktop children. Never shadow the
  # read-only $PID automatic variable (that silently aborts the whole loop).
  $elements = $root.FindAll($TreeScope::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $items = @()
  $errors = @()
  foreach ($element in $elements) {
    try {
      $current = $element.Current
      $ownerPid = [int]$current.ProcessId
      $ownerProcess = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
      $ownerName = if ($ownerProcess) { [string]$ownerProcess.ProcessName } else { '' }
      $items += [PSCustomObject]@{
        Element = $element
        Name = [string]$current.Name
        ProcessId = $ownerPid
        ProcessName = $ownerName
        AutomationId = [string]$current.AutomationId
        ClassName = [string]$current.ClassName
        NativeWindowHandle = [int]$current.NativeWindowHandle
        BoundingRectangle = @{
          X = (ConvertTo-FiniteInt $current.BoundingRectangle.X)
          Y = (ConvertTo-FiniteInt $current.BoundingRectangle.Y)
          Width = (ConvertTo-FiniteInt $current.BoundingRectangle.Width)
          Height = (ConvertTo-FiniteInt $current.BoundingRectangle.Height)
        }
      }
    } catch { $errors += $_.Exception.Message }
  }
  return @{ Items = $items; Errors = $errors; Total = $elements.Count }
}

function Get-TargetWindow {
  $inventory = Get-WindowInventory
  $filtered = @($inventory.Items | Where-Object {
    $nameOk = -not $WindowMatch -or ($_.Name -like "*$WindowMatch*")
    $processOk = -not $ProcessName -or ($_.ProcessName -like "*$ProcessName*")
    $nameOk -and $processOk
  })
  return @{ Items = $filtered; Errors = $inventory.Errors; Total = $inventory.Total }
}

function Get-TargetControl($windowElement) {
  $conditions = @()
  if ($AutomationId) {
    $conditions += New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $AutomationId)
  }
  if ($ControlName) {
    $conditions += New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $ControlName)
  }
  if ($ControlType) {
    $property = $ControlTypeClass::$ControlType
    if ($property) {
      $conditions += New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $property)
    }
  }
  if ($conditions.Count -eq 0) {
    throw 'At least one of AutomationId, ControlName or ControlType is required.'
  }
  $condition = if ($conditions.Count -eq 1) { $conditions[0] } else {
    New-Object System.Windows.Automation.AndCondition([System.Windows.Automation.Condition[]]$conditions)
  }
  return $windowElement.FindFirst($TreeScope::Descendants, $condition)
}

try {
  $lookup = Get-TargetWindow
  $windows = @($lookup.Items)

  if ($Action -eq 'windows') {
    Write-Result @{
      ok = $true
      action = 'windows'
      uiaAvailable = $true
      count = $windows.Count
      enumerated = $lookup.Total
      enumerationErrors = @($lookup.Errors | Select-Object -First 3)
      windows = @($windows | ForEach-Object {
        @{ name = $_.Name; processId = $_.ProcessId; processName = $_.ProcessName;
           automationId = $_.AutomationId; className = $_.ClassName;
           handle = $_.NativeWindowHandle; bounds = $_.BoundingRectangle }
      })
    }
    exit 0
  }

  if ($windows.Count -eq 0) {
    Write-Result @{ ok = $false; code = 'WINDOW_NOT_FOUND'; message = "No window matched '$WindowMatch' / '$ProcessName'." }
    exit 3
  }
  if ($windows.Count -gt 1) {
    # Ambiguous target: never guess which client window belongs to this repo.
    Write-Result @{
      ok = $false; code = 'WINDOW_AMBIGUOUS'; message = 'Multiple windows matched; project selection is uncertain.';
      candidates = @($windows | ForEach-Object { @{ name = $_.Name; processId = $_.ProcessId; automationId = $_.AutomationId } })
    }
    exit 4
  }
  $window = $windows[0]

  switch ($Action) {
    'find' {
      $control = Get-TargetControl $window.Element
      if (-not $control) {
        Write-Result @{ ok = $false; code = 'CONTROL_NOT_FOUND'; message = 'Expected control not found; STOPPING (no blind clicks).'; window = $window.Name }
        exit 5
      }
      Write-Result @{
        ok = $true; action = 'find'; window = $window.Name
        control = @{ name = $control.Current.Name; automationId = $control.Current.AutomationId;
                     controlType = $control.Current.ControlType.ProgrammaticName;
                     isEnabled = $control.Current.IsEnabled; isOffscreen = $control.Current.IsOffscreen }
      }
    }
    'set-value' {
      $control = Get-TargetControl $window.Element
      if (-not $control) {
        Write-Result @{ ok = $false; code = 'CONTROL_NOT_FOUND'; message = 'Input control not found; STOPPING.'; window = $window.Name }
        exit 5
      }
      # Long task packages travel through a UTF-8 file, never through a command
      # line (Windows has a short argv limit and would mangle the quoting).
      if ($ValueFile) {
        if (-not (Test-Path $ValueFile)) {
          Write-Result @{ ok = $false; code = 'VALUE_FILE_MISSING'; message = 'Task package file not found.' }
          exit 6
        }
        $Value = [System.IO.File]::ReadAllText($ValueFile, [System.Text.Encoding]::UTF8)
      }
      try {
        $pattern = $control.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $pattern.SetValue($Value)
      } catch {
        Write-Result @{ ok = $false; code = 'CONTROL_NOT_WRITABLE'; message = $_.Exception.Message; window = $window.Name }
        exit 6
      }
      Write-Result @{ ok = $true; action = 'set-value'; window = $window.Name; valueLength = $Value.Length }
    }
    'invoke' {
      $control = Get-TargetControl $window.Element
      if (-not $control) {
        Write-Result @{ ok = $false; code = 'CONTROL_NOT_FOUND'; message = 'Action control not found; STOPPING.'; window = $window.Name }
        exit 5
      }
      try {
        $pattern = $control.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
      } catch {
        Write-Result @{ ok = $false; code = 'CONTROL_NOT_INVOKABLE'; message = $_.Exception.Message; window = $window.Name }
        exit 6
      }
      Write-Result @{ ok = $true; action = 'invoke'; window = $window.Name }
    }
    'read-text' {
      $textCondition = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $ControlTypeClass::Text)
      $texts = $window.Element.FindAll($TreeScope::Descendants, $textCondition)
      $lines = @()
      foreach ($text in $texts) {
        try {
          $value = $text.Current.Name
          if ($value) { $lines += $value }
        } catch { continue }
      }
      Write-Result @{
        ok = $true; action = 'read-text'; window = $window.Name; count = $lines.Count
        lines = @($lines | Select-Object -First 120)
      }
    }
    'screenshot' {
      if (-not $OutputPath) {
        Write-Result @{ ok = $false; code = 'OUTPUT_PATH_REQUIRED'; message = 'A screenshot destination is required.' }
        exit 7
      }
      $bounds = $window.BoundingRectangle
      if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
        Write-Result @{ ok = $false; code = 'WINDOW_BOUNDS_INVALID'; message = 'Window has no visible bounds.' }
        exit 7
      }
      $bitmap = New-Object System.Drawing.Bitmap([int]$bounds.Width, [int]$bounds.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size)
      $directory = Split-Path -Parent $OutputPath
      if ($directory -and -not (Test-Path $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
      $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose(); $bitmap.Dispose()
      Write-Result @{ ok = $true; action = 'screenshot'; window = $window.Name; path = $OutputPath; width = [int]$bounds.Width; height = [int]$bounds.Height }
    }
  }
} catch {
  Write-Result @{ ok = $false; code = 'UIA_DRIVER_ERROR'; message = $_.Exception.Message }
  exit 8
}
