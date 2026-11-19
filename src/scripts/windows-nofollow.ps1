# Dependency-free Windows no-follow open helper (issue #5287).
# Invoked as process arguments only: powershell.exe -File <this> <mode> <path> [dest]
# Modes: read | create | copy
# Stdout is one JSON object. Binary payloads are base64 under "bytes".
# Exit 0 on success; non-zero on refusal or error (JSON still on stdout when possible).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$Object, [int]$ExitCode) {
  $Object | ConvertTo-Json -Compress -Depth 6
  exit $ExitCode
}

function Fail([string]$Reason, [string]$Code = 'refuse') {
  Write-Result @{ ok = $false; code = $Code; reason = $Reason } 1
}

if ($args.Count -lt 2) {
  Fail 'usage: windows-nofollow.ps1 <read|create|copy> <path> [dest]' 'usage'
}

$Mode = [string]$args[0]
$TargetPath = [string]$args[1]
$DestPath = if ($args.Count -ge 3) { [string]$args[2] } else { $null }

if ($Mode -notin @('read', 'create', 'copy')) {
  Fail "unknown mode: $Mode" 'usage'
}
if ([string]::IsNullOrWhiteSpace($TargetPath)) {
  Fail 'path is required' 'usage'
}
if ($Mode -eq 'copy' -and [string]::IsNullOrWhiteSpace($DestPath)) {
  Fail 'copy requires a destination path' 'usage'
}
if (-not [System.IO.Path]::IsPathRooted($TargetPath)) {
  Fail "path must be absolute: $TargetPath"
}
if (
  $Mode -eq 'copy' -and
  ($DestPath -eq $null -or -not [System.IO.Path]::IsPathRooted($DestPath))
) {
  Fail "path must be absolute: $DestPath"
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class IdNoFollow {
  public const uint GENERIC_READ = 0x80000000;
  public const uint GENERIC_WRITE = 0x40000000;
  public const uint FILE_SHARE_READ = 0x00000001;
  public const uint FILE_SHARE_WRITE = 0x00000002;
  public const uint FILE_SHARE_DELETE = 0x00000004;
  public const uint OPEN_EXISTING = 3;
  public const uint CREATE_NEW = 1;
  public const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
  public const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  public const uint FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;
  public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential)]
  public struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFileW(
    string lpFileName,
    uint dwDesiredAccess,
    uint dwShareMode,
    IntPtr lpSecurityAttributes,
    uint dwCreationDisposition,
    uint dwFlagsAndAttributes,
    IntPtr hTemplateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetFileInformationByHandle(
    IntPtr hFile,
    out BY_HANDLE_FILE_INFORMATION lpFileInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool ReadFile(
    IntPtr hFile,
    byte[] lpBuffer,
    uint nNumberOfBytesToRead,
    out uint lpNumberOfBytesRead,
    IntPtr lpOverlapped);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool WriteFile(
    IntPtr hFile,
    byte[] lpBuffer,
    uint nNumberOfBytesToWrite,
    out uint lpNumberOfBytesWritten,
    IntPtr lpOverlapped);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetFileAttributesW(string lpFileName);

  public const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
}
'@

function Get-Win32Error {
  return [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}

function Open-NoFollow([string]$Path, [uint32]$Access, [uint32]$Disposition) {
  $flags = [IdNoFollow]::FILE_FLAG_OPEN_REPARSE_POINT -bor [IdNoFollow]::FILE_FLAG_BACKUP_SEMANTICS -bor [IdNoFollow]::FILE_FLAG_SEQUENTIAL_SCAN
  $share = [IdNoFollow]::FILE_SHARE_READ -bor [IdNoFollow]::FILE_SHARE_WRITE -bor [IdNoFollow]::FILE_SHARE_DELETE
  $handle = [IdNoFollow]::CreateFileW(
    $Path,
    $Access,
    $share,
    [IntPtr]::Zero,
    $Disposition,
    $flags,
    [IntPtr]::Zero
  )
  if ($handle -eq [IdNoFollow]::INVALID_HANDLE_VALUE) {
    return @{ ok = $false; error = (Get-Win32Error) }
  }
  return @{ ok = $true; handle = $handle }
}

function Close-HandleSafe([IntPtr]$Handle) {
  if ($Handle -ne [IntPtr]::Zero -and $Handle -ne [IdNoFollow]::INVALID_HANDLE_VALUE) {
    [void][IdNoFollow]::CloseHandle($Handle)
  }
}

function Get-HandleInfo([IntPtr]$Handle) {
  $info = New-Object IdNoFollow+BY_HANDLE_FILE_INFORMATION
  if (-not [IdNoFollow]::GetFileInformationByHandle($Handle, [ref]$info)) {
    return $null
  }
  return $info
}

function Classify-Attributes([uint32]$Attrs) {
  $isReparse = ($Attrs -band [IdNoFollow]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0
  $isDir = ($Attrs -band [IdNoFollow]::FILE_ATTRIBUTE_DIRECTORY) -ne 0
  if ($isReparse -and $isDir) { return 'junction-or-dir-reparse' }
  if ($isReparse) { return 'symlink-or-file-reparse' }
  if ($isDir) { return 'directory' }
  return 'file'
}

function Split-AbsoluteComponents([string]$Path) {
  $root = [System.IO.Path]::GetPathRoot($Path)
  if ([string]::IsNullOrEmpty($root)) {
    Fail "cannot resolve path root: $Path"
  }
  # Keep the trailing separator on the root. Path.Combine("C:", "Users")
  # returns the drive-relative "C:Users"; only "C:\" + Combine is safe.
  $normalizedRoot = if ($root.EndsWith('\') -or $root.EndsWith('/')) {
    $root
  } else {
    $root + '\'
  }
  $remainder = $Path.Substring($root.Length).TrimStart([char[]]@('\', '/'))
  $names = @()
  if (-not [string]::IsNullOrEmpty($remainder)) {
    $names = $remainder.Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)
  }
  foreach ($name in $names) {
    if ($name -eq '.' -or $name -eq '..') {
      Fail "path is not normalized: $Path"
    }
  }
  return @{ root = $normalizedRoot; names = $names }
}

function Join-Component([string]$Parent, [string]$Name) {
  if ($Parent.EndsWith('\') -or $Parent.EndsWith('/')) {
    return $Parent + $Name
  }
  return $Parent + '\' + $Name
}

function Assert-ExistingChain([string]$Path, [switch]$FinalMustBeAbsent) {
  $parts = Split-AbsoluteComponents $Path
  $current = $parts.root

  # Classify the volume root itself (must exist as a directory).
  $rootOpen = Open-NoFollow $current ([IdNoFollow]::GENERIC_READ) ([IdNoFollow]::OPEN_EXISTING)
  if (-not $rootOpen.ok) {
    Fail "cannot open path root: $current (win32=$($rootOpen.error))"
  }
  try {
    $rootInfo = Get-HandleInfo $rootOpen.handle
    if ($null -eq $rootInfo) {
      Fail "cannot inspect path root: $current"
    }
    $rootKind = Classify-Attributes $rootInfo.FileAttributes
    if ($rootKind -ne 'directory') {
      Fail "path root is not a plain directory: $current ($rootKind)"
    }
  } finally {
    Close-HandleSafe $rootOpen.handle
  }

  if ($parts.names.Count -eq 0) {
    Fail "refusing the filesystem root as a file target: $Path"
  }

  for ($i = 0; $i -lt $parts.names.Count; $i++) {
    $name = $parts.names[$i]
    $candidate = Join-Component $current $name
    $isFinal = ($i -eq ($parts.names.Count - 1))

    $attrs = [IdNoFollow]::GetFileAttributesW($candidate)
    if ($attrs -eq [IdNoFollow]::INVALID_FILE_ATTRIBUTES) {
      $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      # For an exclusive create, any invalid-attributes result on the final
      # component is treated as absent; CREATE_NEW still refuses if the name
      # appears before the open. A stale Win32 last-error (for example 203)
      # must not block that absent path.
      if ($isFinal -and $FinalMustBeAbsent) {
        return @{ parent = $current; final = $candidate; absent = $true }
      }
      Fail "cannot inspect $candidate (win32=$err)"
    }

    $kind = Classify-Attributes $attrs
    if (-not $isFinal) {
      if ($kind -ne 'directory') {
        Fail "intermediate component is not a plain directory: $candidate ($kind)"
      }
      # Open the directory without following a reparse point to prove the handle.
      $dirOpen = Open-NoFollow $candidate ([IdNoFollow]::GENERIC_READ) ([IdNoFollow]::OPEN_EXISTING)
      if (-not $dirOpen.ok) {
        Fail "cannot open intermediate directory: $candidate (win32=$($dirOpen.error))"
      }
      try {
        $dirInfo = Get-HandleInfo $dirOpen.handle
        if ($null -eq $dirInfo) {
          Fail "cannot inspect intermediate directory: $candidate"
        }
        $openedKind = Classify-Attributes $dirInfo.FileAttributes
        if ($openedKind -ne 'directory') {
          Fail "intermediate component changed underfoot: $candidate ($openedKind)"
        }
      } finally {
        Close-HandleSafe $dirOpen.handle
      }
      $current = $candidate
      continue
    }

    # Final component.
    if ($FinalMustBeAbsent) {
      Fail "exclusive create refuses an existing final component: $candidate ($kind)"
    }
    if ($kind -ne 'file') {
      Fail "final component is not a regular file: $candidate ($kind)"
    }
    return @{ parent = $current; final = $candidate; absent = $false; kind = $kind }
  }
}

function Read-NoFollowFile([string]$Path) {
  $chain = Assert-ExistingChain $Path
  $open = Open-NoFollow $chain.final ([IdNoFollow]::GENERIC_READ) ([IdNoFollow]::OPEN_EXISTING)
  if (-not $open.ok) {
    Fail "cannot open for read: $($chain.final) (win32=$($open.error))"
  }
  try {
    $info = Get-HandleInfo $open.handle
    if ($null -eq $info) {
      Fail "cannot inspect opened file: $($chain.final)"
    }
    $kind = Classify-Attributes $info.FileAttributes
    if ($kind -ne 'file') {
      Fail "opened handle is not a regular file: $($chain.final) ($kind)"
    }
    if ($info.NumberOfLinks -ne 1) {
      Fail "file has more than one hard link (nlink=$($info.NumberOfLinks)): $($chain.final)"
    }
    $size = [uint64]$info.FileSizeLow + ([uint64]$info.FileSizeHigh -shl 32)
    if ($size -gt [uint32]::MaxValue) {
      Fail "file too large to read through this helper: $($chain.final)"
    }
    $buffer = New-Object byte[] ([int]$size)
    if ($size -gt 0) {
      $total = [uint32]0
      while ($total -lt $size) {
        $chunk = New-Object byte[] ([Math]::Min(65536, $size - $total))
        $read = [uint32]0
        if (-not [IdNoFollow]::ReadFile($open.handle, $chunk, [uint32]$chunk.Length, [ref]$read, [IntPtr]::Zero)) {
          Fail "read failed for $($chain.final) (win32=$(Get-Win32Error))"
        }
        if ($read -eq 0) { break }
        [Array]::Copy($chunk, 0, $buffer, $total, $read)
        $total += $read
      }
      if ($total -ne $size) {
        Fail "short read for $($chain.final)"
      }
    }
    $b64 = [Convert]::ToBase64String($buffer)
    Write-Result @{ ok = $true; bytes = $b64; nlink = $info.NumberOfLinks } 0
  } finally {
    Close-HandleSafe $open.handle
  }
}

function Create-NoFollowFile([string]$Path, [byte[]]$Bytes) {
  $chain = Assert-ExistingChain $Path -FinalMustBeAbsent
  $open = Open-NoFollow $chain.final ([IdNoFollow]::GENERIC_WRITE) ([IdNoFollow]::CREATE_NEW)
  if (-not $open.ok) {
    Fail "exclusive create refused for $($chain.final) (win32=$($open.error))"
  }
  $created = $true
  try {
    $info = Get-HandleInfo $open.handle
    if ($null -eq $info) {
      Fail "cannot inspect created file: $($chain.final)"
    }
    $kind = Classify-Attributes $info.FileAttributes
    if ($kind -ne 'file') {
      Fail "created handle is not a regular file: $($chain.final) ($kind)"
    }
    if ($null -ne $Bytes -and $Bytes.Length -gt 0) {
      $offset = 0
      while ($offset -lt $Bytes.Length) {
        $remaining = $Bytes.Length - $offset
        $chunkSize = [Math]::Min(65536, $remaining)
        $chunk = New-Object byte[] $chunkSize
        [Array]::Copy($Bytes, $offset, $chunk, 0, $chunkSize)
        $written = [uint32]0
        if (-not [IdNoFollow]::WriteFile($open.handle, $chunk, [uint32]$chunkSize, [ref]$written, [IntPtr]::Zero)) {
          # Leave the new file at the caller-chosen path; do not delete it.
          Fail "write failed after exclusive create at $($chain.final) (win32=$(Get-Win32Error)); leftover path: $($chain.final)"
        }
        if ($written -eq 0) {
          Fail "write made no progress after exclusive create at $($chain.final); leftover path: $($chain.final)"
        }
        $offset += [int]$written
      }
    }
    Write-Result @{ ok = $true; path = $chain.final; created = $created } 0
  } finally {
    Close-HandleSafe $open.handle
  }
}

function Copy-NoFollowFile([string]$Source, [string]$Destination) {
  # Read source through the no-follow open, then exclusive-create the destination.
  # Re-validate the destination parent chain so a directory link cannot redirect the write.
  $sourceChain = Assert-ExistingChain $Source
  $destChain = Assert-ExistingChain $Destination -FinalMustBeAbsent

  $destParentFull = [System.IO.Path]::GetFullPath($destChain.parent)
  $destFinalFull = [System.IO.Path]::GetFullPath($destChain.final)
  $destParentPrefix = $destParentFull.TrimEnd('\') + '\'
  if (-not $destFinalFull.StartsWith($destParentPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "destination escapes its parent directory: $Destination"
  }
  if ([System.IO.Path]::GetDirectoryName($destFinalFull) -ne $destParentFull.TrimEnd('\')) {
    # GetDirectoryName on a drive root can differ; compare leaf only when parent is non-root.
    $leaf = [System.IO.Path]::GetFileName($destFinalFull)
    $rejoined = [System.IO.Path]::Combine($destParentFull.TrimEnd('\'), $leaf)
    if ([System.IO.Path]::GetFullPath($rejoined) -ne $destFinalFull) {
      Fail "destination is not a direct child of its verified parent: $Destination"
    }
  }

  $srcOpen = Open-NoFollow $sourceChain.final ([IdNoFollow]::GENERIC_READ) ([IdNoFollow]::OPEN_EXISTING)
  if (-not $srcOpen.ok) {
    Fail "cannot open source for copy: $($sourceChain.final) (win32=$($srcOpen.error))"
  }
  try {
    $srcInfo = Get-HandleInfo $srcOpen.handle
    if ($null -eq $srcInfo) {
      Fail "cannot inspect source: $($sourceChain.final)"
    }
    $srcKind = Classify-Attributes $srcInfo.FileAttributes
    if ($srcKind -ne 'file') {
      Fail "source is not a regular file: $($sourceChain.final) ($srcKind)"
    }
    if ($srcInfo.NumberOfLinks -ne 1) {
      Fail "source has more than one hard link (nlink=$($srcInfo.NumberOfLinks)): $($sourceChain.final)"
    }
    $size = [uint64]$srcInfo.FileSizeLow + ([uint64]$srcInfo.FileSizeHigh -shl 32)
    if ($size -gt [uint32]::MaxValue) {
      Fail "source too large to copy through this helper: $($sourceChain.final)"
    }
    $buffer = New-Object byte[] ([int]$size)
    if ($size -gt 0) {
      $total = [uint32]0
      while ($total -lt $size) {
        $chunk = New-Object byte[] ([Math]::Min(65536, $size - $total))
        $read = [uint32]0
        if (-not [IdNoFollow]::ReadFile($srcOpen.handle, $chunk, [uint32]$chunk.Length, [ref]$read, [IntPtr]::Zero)) {
          Fail "source read failed: $($sourceChain.final) (win32=$(Get-Win32Error))"
        }
        if ($read -eq 0) { break }
        [Array]::Copy($chunk, 0, $buffer, $total, $read)
        $total += $read
      }
      if ($total -ne $size) {
        Fail "short source read: $($sourceChain.final)"
      }
    }
  } finally {
    Close-HandleSafe $srcOpen.handle
  }

  Create-NoFollowFile $Destination $buffer
}

switch ($Mode) {
  'read' { Read-NoFollowFile $TargetPath }
  'create' {
    # Content arrives as a base64 process argument (never interpolated into a
    # command string) or, when omitted, as raw bytes on stdin.
    $bytes = [byte[]]@()
    if ($args.Count -ge 3 -and -not [string]::IsNullOrEmpty([string]$args[2])) {
      $bytes = [Convert]::FromBase64String([string]$args[2])
    } elseif (-not [Console]::IsInputRedirected) {
      $bytes = [byte[]]@()
    } else {
      $stdin = [Console]::OpenStandardInput()
      $ms = New-Object System.IO.MemoryStream
      $stdin.CopyTo($ms)
      $bytes = $ms.ToArray()
    }
    Create-NoFollowFile $TargetPath $bytes
  }
  'copy' { Copy-NoFollowFile $TargetPath $DestPath }
  default { Fail "unknown mode: $Mode" 'usage' }
}
