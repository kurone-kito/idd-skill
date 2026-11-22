# Dependency-free Windows no-follow open helper (issue #5287).
# Invoked as process arguments only: powershell.exe -File <this> <mode> <path> [dest]
# Modes: read | create | copy
# Stdout is one JSON object. Binary payloads for read are written to a
# caller-provided staging file (args[2]) so Node's maxBuffer is not the
# transport limit; small reads may still embed base64 under "bytes".
# Exit 0 on success; non-zero on refusal or error (JSON still on stdout when possible).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Match Node's UTF-8 stdout decode so staging paths with non-ASCII characters
# survive the process boundary on a non-UTF-8 console code page.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Result([hashtable]$Object, [int]$ExitCode) {
  $Object | ConvertTo-Json -Compress -Depth 6
  exit $ExitCode
}

function Fail([string]$Reason, [string]$Code = 'refuse') {
  Write-Result @{ ok = $false; code = $Code; reason = $Reason } 1
}

if ($args.Count -lt 2) {
  Fail 'usage: windows-nofollow.ps1 <read|create|copy|probe-relative> <path> [dest-or-bytes]' 'usage'
}

$Mode = [string]$args[0]
$TargetPath = [string]$args[1]
$DestPath = if ($args.Count -ge 3) { [string]$args[2] } else { $null }

if ($Mode -notin @('read', 'create', 'copy', 'probe-relative')) {
  Fail "unknown mode: $Mode" 'usage'
}
if ([string]::IsNullOrWhiteSpace($TargetPath)) {
  Fail 'path is required' 'usage'
}
if ($Mode -eq 'copy' -and [string]::IsNullOrWhiteSpace($DestPath)) {
  Fail 'copy requires a destination path' 'usage'
}
if ($Mode -eq 'read' -and [string]::IsNullOrWhiteSpace($DestPath)) {
  Fail 'read requires a staging output path' 'usage'
}
if (-not [System.IO.Path]::IsPathRooted($TargetPath)) {
  Fail "path must be absolute: $TargetPath"
}
if (
  $Mode -in @('copy', 'read') -and
  ($DestPath -eq $null -or -not [System.IO.Path]::IsPathRooted($DestPath))
) {
  Fail "path must be absolute: $DestPath"
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class IdNoFollow {
  public const uint GENERIC_READ = 0x80000000;
  public const uint GENERIC_WRITE = 0x40000000;
  public const uint GENERIC_EXECUTE = 0x20000000;
  public const uint SYNCHRONIZE = 0x00100000;
  public const uint DELETE = 0x00010000;
  // NtCreateFile is stricter than CreateFileW: GetFileInformationByHandle
  // needs FILE_READ_ATTRIBUTES even on a write-only create handle, and a
  // RootDirectory handle needs FILE_TRAVERSE (covered by GENERIC_EXECUTE).
  public const uint FILE_READ_ATTRIBUTES = 0x00000080;
  public const uint FILE_WRITE_ATTRIBUTES = 0x00000100;
  public const uint FILE_TRAVERSE = 0x00000020;
  public const uint FILE_LIST_DIRECTORY = 0x00000001;
  public const uint FILE_SHARE_READ = 0x00000001;
  public const uint FILE_SHARE_WRITE = 0x00000002;
  public const uint FILE_SHARE_DELETE = 0x00000004;
  public const uint OPEN_EXISTING = 3;
  public const uint CREATE_NEW = 1;
  public const int FileDispositionInfo = 4;
  public const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
  public const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  public const uint FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;
  public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  // NtCreateFile CreateDisposition values.
  public const uint FILE_OPEN = 1;
  public const uint FILE_CREATE = 2;

  // NtCreateFile CreateOptions.
  public const uint FILE_DIRECTORY_FILE = 0x00000001;
  public const uint FILE_SEQUENTIAL_ONLY = 0x00000004;
  public const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
  public const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
  public const uint FILE_OPEN_FOR_BACKUP_INTENT = 0x00004000;
  public const uint FILE_OPEN_REPARSE_POINT = 0x00200000;

  // OBJECT_ATTRIBUTES.Attributes: refuse reparse on the looked-up name
  // and keep the relative open bound to RootDirectory (issue #5292).
  public const uint OBJ_CASE_INSENSITIVE = 0x00000040;
  public const uint OBJ_DONT_REPARSE = 0x00001000;

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

  [StructLayout(LayoutKind.Sequential)]
  public struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public IntPtr Information;
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

  [DllImport("ntdll.dll")]
  public static extern int NtCreateFile(
    out IntPtr FileHandle,
    uint DesiredAccess,
    ref OBJECT_ATTRIBUTES ObjectAttributes,
    out IO_STATUS_BLOCK IoStatusBlock,
    IntPtr AllocationSize,
    uint FileAttributes,
    uint ShareAccess,
    uint CreateDisposition,
    uint CreateOptions,
    IntPtr EaBuffer,
    uint EaLength);

  [DllImport("ntdll.dll")]
  public static extern uint RtlNtStatusToDosError(int Status);

  // SetLastError = true so Marshal.GetLastWin32Error() sees the translated
  // status after SetLastError on the Windows PS 5.1 / .NET Framework host.
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern void SetLastError(uint dwErrCode);

  public static int LastDosError;

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

  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_DISPOSITION_INFO {
    [MarshalAs(UnmanagedType.U1)]
    public bool DeleteFile;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetFileInformationByHandle(
    IntPtr hFile,
    int FileInformationClass,
    ref FILE_DISPOSITION_INFO lpFileInformation,
    uint dwBufferSize);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetFileAttributesW(string lpFileName);

  public const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;

  /// <summary>
  /// Open a single path component relative to an already-held parent
  /// directory handle. Absolute CreateFileW still walks intermediate
  /// reparse points even with FILE_FLAG_OPEN_REPARSE_POINT; this path
  /// binds the lookup to RootDirectory with OBJ_DONT_REPARSE (#5292).
  /// </summary>
  /// <param name="kind">
  /// 0 = file (FILE_NON_DIRECTORY_FILE), 1 = directory, 2 = either (inspect).
  /// </param>
  /// <param name="needWriteAttributes">
  /// When true, also request FILE_WRITE_ATTRIBUTES (create/write only).
  /// Read opens must stay read-only so ACLs without that right still work.
  /// </param>
  public static IntPtr CreateRelative(
    IntPtr rootDirectory,
    string name,
    uint desiredAccess,
    uint shareAccess,
    uint createDisposition,
    int kind,
    bool needWriteAttributes)
  {
    LastDosError = 0;
    if (rootDirectory == IntPtr.Zero || rootDirectory == INVALID_HANDLE_VALUE) {
      return INVALID_HANDLE_VALUE;
    }
    if (string.IsNullOrEmpty(name) || name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0 || name.IndexOf('\0') >= 0) {
      return INVALID_HANDLE_VALUE;
    }

    IntPtr nameBuffer = Marshal.StringToHGlobalUni(name);
    IntPtr nameStruct = IntPtr.Zero;
    try {
      UNICODE_STRING unicodeName = new UNICODE_STRING();
      unicodeName.Length = (ushort)(name.Length * 2);
      unicodeName.MaximumLength = (ushort)(unicodeName.Length + 2);
      unicodeName.Buffer = nameBuffer;

      nameStruct = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(unicodeName, nameStruct, false);

      OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES();
      attributes.Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));
      attributes.RootDirectory = rootDirectory;
      attributes.ObjectName = nameStruct;
      attributes.Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE;
      attributes.SecurityDescriptor = IntPtr.Zero;
      attributes.SecurityQualityOfService = IntPtr.Zero;

      uint createOptions = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT;
      if (kind == 1) {
        createOptions |= FILE_DIRECTORY_FILE | FILE_OPEN_FOR_BACKUP_INTENT;
      } else if (kind == 0) {
        createOptions |= FILE_NON_DIRECTORY_FILE | FILE_SEQUENTIAL_ONLY;
      } else {
        // Inspect: allow file or directory so Classify-Attributes can refuse.
        createOptions |= FILE_OPEN_FOR_BACKUP_INTENT | FILE_SEQUENTIAL_ONLY;
      }

      uint access = desiredAccess | SYNCHRONIZE | FILE_READ_ATTRIBUTES;
      if (needWriteAttributes) {
        access |= FILE_WRITE_ATTRIBUTES;
      }

      IO_STATUS_BLOCK ioStatus;
      IntPtr handle;
      int status = NtCreateFile(
        out handle,
        access,
        ref attributes,
        out ioStatus,
        IntPtr.Zero,
        FILE_ATTRIBUTE_NORMAL,
        shareAccess,
        createDisposition,
        createOptions,
        IntPtr.Zero,
        0);
      if (status < 0) {
        // Windows PowerShell 5.1's Add-Type targets .NET Framework, which
        // lacks Marshal.SetLastWin32Error; use kernel32 SetLastError and
        // keep LastDosError so callers do not depend on a stale cache.
        uint dos = RtlNtStatusToDosError(status);
        LastDosError = (int)dos;
        SetLastError(dos);
        return INVALID_HANDLE_VALUE;
      }
      return handle;
    } finally {
      if (nameStruct != IntPtr.Zero) {
        Marshal.FreeHGlobal(nameStruct);
      }
      Marshal.FreeHGlobal(nameBuffer);
    }
  }
}
'@

function Get-Win32Error {
  return [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}

# Directories are opened without FILE_SHARE_DELETE so a held handle blocks
# rename/delete/replace of that component until the caller closes it. Files
# allow read sharing only.
#
# Absolute CreateFileW still walks intermediate reparse points on the path
# string even with FILE_FLAG_OPEN_REPARSE_POINT. Prefer Open-NoFollowRelative
# once a parent directory handle is held (#5292).
function Open-NoFollow(
  [string]$Path,
  [uint32]$Access,
  [uint32]$Disposition,
  [switch]$IsDirectory
) {
  $flags = [IdNoFollow]::FILE_FLAG_OPEN_REPARSE_POINT -bor [IdNoFollow]::FILE_FLAG_BACKUP_SEMANTICS -bor [IdNoFollow]::FILE_FLAG_SEQUENTIAL_SCAN
  $share = [IdNoFollow]::FILE_SHARE_READ
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

# Open one path component relative to a held parent directory handle with
# NtCreateFile(RootDirectory, OBJ_DONT_REPARSE). Keeps the lookup bound to
# that directory object so a concurrent reparse on an intermediate absolute
# path cannot redirect the final open (#5292).
function Open-NoFollowRelative(
  [IntPtr]$ParentHandle,
  [string]$Name,
  [uint32]$Access,
  [uint32]$Disposition,
  [switch]$IsDirectory,
  [switch]$AllowAny,
  [switch]$NeedWriteAttributes
) {
  if ($Name -match '[\\/\0]' -or $Name -eq '.' -or $Name -eq '..') {
    return @{ ok = $false; error = -1 }
  }
  $ntDisposition = if ($Disposition -eq [IdNoFollow]::CREATE_NEW) {
    [IdNoFollow]::FILE_CREATE
  } else {
    [IdNoFollow]::FILE_OPEN
  }
  $kind = if ($AllowAny) { 2 } elseif ($IsDirectory) { 1 } else { 0 }
  $share = [IdNoFollow]::FILE_SHARE_READ
  $handle = [IdNoFollow]::CreateRelative(
    $ParentHandle,
    $Name,
    $Access,
    $share,
    $ntDisposition,
    $kind,
    [bool]$NeedWriteAttributes
  )
  if ($handle -eq [IdNoFollow]::INVALID_HANDLE_VALUE) {
    $dos = [IdNoFollow]::LastDosError
    if ($dos -eq 0) { $dos = Get-Win32Error }
    return @{ ok = $false; error = $dos }
  }
  return @{ ok = $true; handle = $handle }
}

function Close-HandleSafe([IntPtr]$Handle) {
  if ($Handle -ne [IntPtr]::Zero -and $Handle -ne [IdNoFollow]::INVALID_HANDLE_VALUE) {
    [void][IdNoFollow]::CloseHandle($Handle)
  }
}

function Close-HandleList([System.Collections.ArrayList]$Handles) {
  if ($null -eq $Handles) { return }
  foreach ($handle in $Handles) {
    Close-HandleSafe ([IntPtr]$handle)
  }
  $Handles.Clear()
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
    # Reject NTFS alternate data stream syntax in components after the root
    # (drive-letter colon stays in the root only).
    if ($name.Contains(':')) {
      Fail "path component looks like an alternate data stream: $name"
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

# Walk every existing component from a handle opened with
# FILE_FLAG_OPEN_REPARSE_POINT (root) or NtCreateFile relative to the held
# parent (deeper names, issue #5292). Intermediate directory handles stay
# open in HeldHandles until the caller finishes I/O, so a replace of those
# components fails while the chain is held (no FILE_SHARE_DELETE), and the
# final open cannot be redirected by an absolute-path reparse walk.
function Assert-ExistingChain(
  [string]$Path,
  [switch]$FinalMustBeAbsent,
  [System.Collections.ArrayList]$HeldHandles
) {
  $parts = Split-AbsoluteComponents $Path
  $current = $parts.root

  # GENERIC_EXECUTE supplies FILE_TRAVERSE so the final NtCreateFile can use
  # the last held directory as RootDirectory (#5292).
  $rootOpen = Open-NoFollow $current ([IdNoFollow]::GENERIC_READ -bor [IdNoFollow]::GENERIC_EXECUTE) ([IdNoFollow]::OPEN_EXISTING) -IsDirectory
  if (-not $rootOpen.ok) {
    Fail "cannot open path root: $current (win32=$($rootOpen.error))"
  }
  [void]$HeldHandles.Add($rootOpen.handle)
  $rootInfo = Get-HandleInfo $rootOpen.handle
  if ($null -eq $rootInfo) {
    Fail "cannot inspect path root: $current"
  }
  $rootKind = Classify-Attributes $rootInfo.FileAttributes
  if ($rootKind -ne 'directory') {
    Fail "path root is not a plain directory: $current ($rootKind)"
  }

  if ($parts.names.Count -eq 0) {
    Fail "refusing the filesystem root as a file target: $Path"
  }

  for ($i = 0; $i -lt $parts.names.Count; $i++) {
    $name = $parts.names[$i]
    $candidate = Join-Component $current $name
    $isFinal = ($i -eq ($parts.names.Count - 1))
    $parentHandle = [IntPtr]$HeldHandles[$HeldHandles.Count - 1]

    if (-not $isFinal) {
      # Intermediate walk keeps absolute CreateFileW with OPEN_REPARSE_POINT
      # and holds the handle without FILE_SHARE_DELETE (issue #5287). Only the
      # final open below is parent-relative (#5292); absolute CreateFileW still
      # walks intermediate reparse points on the path string.
      $dirOpen = Open-NoFollow $candidate ([IdNoFollow]::GENERIC_READ -bor [IdNoFollow]::GENERIC_EXECUTE) ([IdNoFollow]::OPEN_EXISTING) -IsDirectory
      if (-not $dirOpen.ok) {
        Fail "cannot open intermediate directory: $candidate (win32=$($dirOpen.error))"
      }
      [void]$HeldHandles.Add($dirOpen.handle)
      $dirInfo = Get-HandleInfo $dirOpen.handle
      if ($null -eq $dirInfo) {
        Fail "cannot inspect intermediate directory: $candidate"
      }
      $openedKind = Classify-Attributes $dirInfo.FileAttributes
      if ($openedKind -ne 'directory') {
        Fail "intermediate component is not a plain directory: $candidate ($openedKind)"
      }
      $current = $candidate
      continue
    }

    # Final component: classify from a parent-relative no-follow handle.
    # AllowAny so a directory final still opens and Classify can refuse it.
    $finalOpen = Open-NoFollowRelative $parentHandle $name ([IdNoFollow]::GENERIC_READ) ([IdNoFollow]::OPEN_EXISTING) -AllowAny
    if (-not $finalOpen.ok) {
      # For an exclusive create, a failed open of the final name is treated as
      # absent; CREATE_NEW still refuses if the name appears before the open.
      if ($FinalMustBeAbsent) {
        return @{
          parent = $current
          final = $candidate
          finalName = $name
          parentHandle = $parentHandle
          absent = $true
        }
      }
      Fail "cannot open final component: $candidate (win32=$($finalOpen.error))"
    }
    try {
      $finalInfo = Get-HandleInfo $finalOpen.handle
      if ($null -eq $finalInfo) {
        Fail "cannot inspect final component: $candidate"
      }
      $kind = Classify-Attributes $finalInfo.FileAttributes
      if ($FinalMustBeAbsent) {
        Fail "exclusive create refuses an existing final component: $candidate ($kind)"
      }
      if ($kind -ne 'file') {
        Fail "final component is not a regular file: $candidate ($kind)"
      }
      return @{
        parent = $current
        final = $candidate
        finalName = $name
        parentHandle = $parentHandle
        absent = $false
        kind = $kind
      }
    } finally {
      Close-HandleSafe $finalOpen.handle
    }
  }
}

function Read-BytesFromHandle([IntPtr]$Handle, [string]$Label) {
  $info = Get-HandleInfo $Handle
  if ($null -eq $info) {
    Fail "cannot inspect opened file: $Label"
  }
  $kind = Classify-Attributes $info.FileAttributes
  if ($kind -ne 'file') {
    Fail "opened handle is not a regular file: $Label ($kind)"
  }
  if ($info.NumberOfLinks -ne 1) {
    Fail "file has more than one hard link (nlink=$($info.NumberOfLinks)): $Label"
  }
  $size = [uint64]$info.FileSizeLow + ([uint64]$info.FileSizeHigh -shl 32)
  if ($size -gt [uint32]::MaxValue) {
    Fail "file too large to read through this helper: $Label"
  }
  $buffer = New-Object byte[] ([int]$size)
  if ($size -gt 0) {
    $total = [uint32]0
    while ($total -lt $size) {
      $chunk = New-Object byte[] ([Math]::Min(65536, $size - $total))
      $read = [uint32]0
      if (-not [IdNoFollow]::ReadFile($Handle, $chunk, [uint32]$chunk.Length, [ref]$read, [IntPtr]::Zero)) {
        Fail "read failed for $Label (win32=$(Get-Win32Error))"
      }
      if ($read -eq 0) { break }
      [Array]::Copy($chunk, 0, $buffer, $total, $read)
      $total += $read
    }
    if ($total -ne $size) {
      Fail "short read for $Label"
    }
  }
  return @{ buffer = $buffer; nlink = $info.NumberOfLinks }
}

function Write-BytesToHandle([IntPtr]$Handle, [byte[]]$Bytes, [string]$Label) {
  if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return }
  $offset = 0
  while ($offset -lt $Bytes.Length) {
    $remaining = $Bytes.Length - $offset
    $chunkSize = [Math]::Min(65536, $remaining)
    $chunk = New-Object byte[] $chunkSize
    [Array]::Copy($Bytes, $offset, $chunk, 0, $chunkSize)
    $written = [uint32]0
    if (-not [IdNoFollow]::WriteFile($Handle, $chunk, [uint32]$chunkSize, [ref]$written, [IntPtr]::Zero)) {
      Fail "write failed after exclusive create at $Label (win32=$(Get-Win32Error))"
    }
    if ($written -eq 0) {
      Fail "write made no progress after exclusive create at $Label"
    }
    $offset += [int]$written
  }
}

function Mark-HandleForDelete([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero -or $Handle -eq [IdNoFollow]::INVALID_HANDLE_VALUE) {
    return
  }
  $info = New-Object IdNoFollow+FILE_DISPOSITION_INFO
  $info.DeleteFile = $true
  # FILE_DISPOSITION_INFO is one byte; bind cleanup to this handle so a
  # path recreate after close cannot be deleted by name (#5290 review).
  [void][IdNoFollow]::SetFileInformationByHandle(
    $Handle,
    [IdNoFollow]::FileDispositionInfo,
    [ref]$info,
    [uint32]1
  )
}

function Read-NoFollowFile([string]$Path, [string]$StagingPath) {
  $held = New-Object System.Collections.ArrayList
  try {
    $chain = Assert-ExistingChain $Path -HeldHandles $held
    # Parent directory handles stay open for the relative final open and
    # read so a concurrent reparse on an absolute intermediate path cannot
    # redirect the lookup (#5292).
    $open = Open-NoFollowRelative ([IntPtr]$chain.parentHandle) ([string]$chain.finalName) ([IdNoFollow]::GENERIC_READ) ([IdNoFollow]::OPEN_EXISTING)
    if (-not $open.ok) {
      Fail "cannot open for read: $($chain.final) (win32=$($open.error))"
    }
    try {
      $payload = Read-BytesFromHandle $open.handle $chain.final
      # Deliver bytes through the staging path so stdout stays small.
      $stageHeld = New-Object System.Collections.ArrayList
      try {
        $stageChain = Assert-ExistingChain $StagingPath -FinalMustBeAbsent -HeldHandles $stageHeld
        $stageOpen = Open-NoFollowRelative ([IntPtr]$stageChain.parentHandle) ([string]$stageChain.finalName) ([IdNoFollow]::GENERIC_WRITE) ([IdNoFollow]::CREATE_NEW) -NeedWriteAttributes
        if (-not $stageOpen.ok) {
          Fail "cannot create staging file: $($stageChain.final) (win32=$($stageOpen.error))"
        }
        try {
          Write-BytesToHandle $stageOpen.handle $payload.buffer $stageChain.final
        } finally {
          Close-HandleSafe $stageOpen.handle
        }
      } finally {
        Close-HandleList $stageHeld
      }
      $hasher = [System.Security.Cryptography.SHA256]::Create()
      try {
        $hashBytes = $hasher.ComputeHash($payload.buffer)
      } finally {
        $hasher.Dispose()
      }
      $sha = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
      Write-Result @{
        ok = $true
        bytesPath = $StagingPath
        sha256 = $sha
        nlink = $payload.nlink
      } 0
    } finally {
      Close-HandleSafe $open.handle
    }
  } finally {
    Close-HandleList $held
  }
}

function Create-NoFollowFile([string]$Path, [byte[]]$Bytes) {
  $held = New-Object System.Collections.ArrayList
  try {
    $chain = Assert-ExistingChain $Path -FinalMustBeAbsent -HeldHandles $held
    # DELETE access lets a failed create mark disposition on the same handle
    # before close, so cleanup cannot race a path-based recreate (#5290).
    $access = [IdNoFollow]::GENERIC_WRITE -bor [IdNoFollow]::DELETE
    $open = Open-NoFollowRelative ([IntPtr]$chain.parentHandle) ([string]$chain.finalName) $access ([IdNoFollow]::CREATE_NEW) -NeedWriteAttributes
    if (-not $open.ok) {
      Fail "exclusive create refused for $($chain.final) (win32=$($open.error))"
    }
    $keepCreated = $false
    try {
      $info = Get-HandleInfo $open.handle
      if ($null -eq $info) {
        Fail "cannot inspect created file: $($chain.final)"
      }
      $kind = Classify-Attributes $info.FileAttributes
      if ($kind -ne 'file') {
        Fail "created handle is not a regular file: $($chain.final) ($kind)"
      }
      Write-BytesToHandle $open.handle $Bytes $chain.final
      $keepCreated = $true
      Write-Result @{ ok = $true; path = $chain.final; created = $true } 0
    } finally {
      if (-not $keepCreated) {
        Mark-HandleForDelete $open.handle
      }
      Close-HandleSafe $open.handle
    }
  } finally {
    Close-HandleList $held
  }
}

function Copy-NoFollowFile([string]$Source, [string]$Destination) {
  $srcHeld = New-Object System.Collections.ArrayList
  $destHeld = New-Object System.Collections.ArrayList
  try {
    $sourceChain = Assert-ExistingChain $Source -HeldHandles $srcHeld
    $destChain = Assert-ExistingChain $Destination -FinalMustBeAbsent -HeldHandles $destHeld

    # Preserve a drive-root separator: Path.Combine("C:", "leaf") is "C:leaf".
    # Join-Component keeps "C:\" + leaf as "C:\leaf".
    $destFinalFull = [System.IO.Path]::GetFullPath($destChain.final)
    $destParentNormalized = [System.IO.Path]::GetFullPath($destChain.parent)
    $destParentPrefix = if (
      $destParentNormalized.EndsWith('\') -or $destParentNormalized.EndsWith('/')
    ) {
      $destParentNormalized
    } else {
      $destParentNormalized + '\'
    }
    if (-not $destFinalFull.StartsWith($destParentPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Fail "destination escapes its parent directory: $Destination"
    }
    $leaf = [System.IO.Path]::GetFileName($destFinalFull)
    $rejoined = Join-Component $destParentPrefix $leaf
    if ([System.IO.Path]::GetFullPath($rejoined) -ne $destFinalFull) {
      Fail "destination is not a direct child of its verified parent: $Destination"
    }

    $srcOpen = Open-NoFollowRelative ([IntPtr]$sourceChain.parentHandle) ([string]$sourceChain.finalName) ([IdNoFollow]::GENERIC_READ) ([IdNoFollow]::OPEN_EXISTING)
    if (-not $srcOpen.ok) {
      Fail "cannot open source for copy: $($sourceChain.final) (win32=$($srcOpen.error))"
    }
    try {
      # Stream the copy in bounded chunks, so no file is held whole and no size
      # limit applies. Hard links are allowed here: the source is only read, and
      # recovery preserves its content, not its link count. The identity of the
      # handle that was read is returned, so the caller can bind its check to
      # the bytes it copied.
      $srcInfo = Get-HandleInfo $srcOpen.handle
      if ($null -eq $srcInfo) {
        Fail "cannot inspect opened source for copy: $($sourceChain.final)"
      }
      $srcKind = Classify-Attributes $srcInfo.FileAttributes
      if ($srcKind -ne 'file') {
        Fail "opened source is not a regular file: $($sourceChain.final) ($srcKind)"
      }
      $destAccess = [IdNoFollow]::GENERIC_WRITE -bor [IdNoFollow]::DELETE
      $destOpen = Open-NoFollowRelative ([IntPtr]$destChain.parentHandle) ([string]$destChain.finalName) $destAccess ([IdNoFollow]::CREATE_NEW) -NeedWriteAttributes
      if (-not $destOpen.ok) {
        Fail "exclusive create refused for $($destChain.final) (win32=$($destOpen.error))"
      }
      $keepCreated = $false
      try {
        $info = Get-HandleInfo $destOpen.handle
        if ($null -eq $info) {
          Fail "cannot inspect created file: $($destChain.final)"
        }
        $kind = Classify-Attributes $info.FileAttributes
        if ($kind -ne 'file') {
          Fail "created handle is not a regular file: $($destChain.final) ($kind)"
        }
        # Copy exactly the length the handle reports at open. A source that
        # grows during the copy cannot extend it, so the copy stays bounded; a
        # source that ends early fails here, and the caller's size and metadata
        # checks reject any other change.
        $remaining = ([uint64]$srcInfo.FileSizeHigh -shl 32) -bor [uint64]$srcInfo.FileSizeLow
        $chunk = New-Object byte[] 65536
        while ($remaining -gt 0) {
          $want = [uint32][Math]::Min([uint64]$chunk.Length, $remaining)
          $read = [uint32]0
          if (-not [IdNoFollow]::ReadFile($srcOpen.handle, $chunk, $want, [ref]$read, [IntPtr]::Zero)) {
            Fail "read failed during copy of $($sourceChain.final) (win32=$(Get-Win32Error))"
          }
          if ($read -eq 0) {
            Fail "source ended before its snapshot length during copy of $($sourceChain.final)"
          }
          $piece = New-Object byte[] ([int]$read)
          [Array]::Copy($chunk, 0, $piece, 0, [int]$read)
          Write-BytesToHandle $destOpen.handle $piece $destChain.final
          $remaining -= [uint64]$read
        }
        $keepCreated = $true
        $sourceIndex = ([uint64]$srcInfo.FileIndexHigh -shl 32) -bor [uint64]$srcInfo.FileIndexLow
        Write-Result @{ ok = $true; path = $destChain.final; created = $true; sourceVolume = [uint32]$srcInfo.VolumeSerialNumber; sourceIndex = [string]$sourceIndex } 0
      } finally {
        if (-not $keepCreated) {
          Mark-HandleForDelete $destOpen.handle
        }
        Close-HandleSafe $destOpen.handle
      }
    } finally {
      Close-HandleSafe $srcOpen.handle
    }
  } finally {
    Close-HandleList $srcHeld
    Close-HandleList $destHeld
  }
}

# Deterministic seam for #5292: hold the parent directory handle, then open
# the final name only via NtCreateFile(RootDirectory, OBJ_DONT_REPARSE). A
# concurrent absolute-path reparse walk cannot feed this open.
function Probe-RelativeFinal([string]$Path) {
  $held = New-Object System.Collections.ArrayList
  try {
    $chain = Assert-ExistingChain $Path -HeldHandles $held
    $open = Open-NoFollowRelative ([IntPtr]$chain.parentHandle) ([string]$chain.finalName) ([IdNoFollow]::GENERIC_READ) ([IdNoFollow]::OPEN_EXISTING)
    if (-not $open.ok) {
      Fail "probe-relative cannot open final: $($chain.final) (win32=$($open.error))"
    }
    try {
      $payload = Read-BytesFromHandle $open.handle $chain.final
      $hasher = [System.Security.Cryptography.SHA256]::Create()
      try {
        $hashBytes = $hasher.ComputeHash($payload.buffer)
      } finally {
        $hasher.Dispose()
      }
      $sha = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
      Write-Result @{
        ok = $true
        via = 'relative'
        path = $chain.final
        parent = $chain.parent
        sha256 = $sha
        nlink = $payload.nlink
      } 0
    } finally {
      Close-HandleSafe $open.handle
    }
  } finally {
    Close-HandleList $held
  }
}

switch ($Mode) {
  'read' { Read-NoFollowFile $TargetPath $DestPath }
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
  'probe-relative' { Probe-RelativeFinal $TargetPath }
  default { Fail "unknown mode: $Mode" 'usage' }
}
