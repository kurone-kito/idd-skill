// idd-generated-from: src/scripts/windows-process-cwd.mts
//
// The scripts/windows-process-cwd.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Batch reader for the current directory of every process on Windows
// (kurone-kito/idd-skill#5346, roadmap #5285). Linux reads `/proc/<pid>/cwd`
// one process at a time; Windows has no such link, so one System32 PowerShell
// call opens each process, reads its bitness, owner SID, and (for a 64-bit
// process) the current directory out of its parameters block, and prints one
// JSON object. The parser here checks that object, so a caller that maps the
// records to a verdict only ever sees four well-formed kinds. The reader does
// not filter by owner: the mapping selects the records whose `ownerSid`
// equals `currentSid`.

import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

import type { WindowsAclProcessDeps } from './windows-acl.mts';

/** What one process read ended as. */
export type WindowsProcessKind = 'exited' | 'denied' | 'live' | 'error';

/**
 * One process. `exited`: the process is gone, so every other field is null.
 * `denied`: the read was refused; `ownerSid` is the owner or null, and
 * `bitness` and `directory` are null. `live`: `directory` is the current
 * directory of a 64-bit process, or null when `bitness` is 32 (the directory
 * of a 32-bit process is not read). `error`: any other failure, with a
 * `reason`.
 */
export interface WindowsProcessRecord {
  pid: number;
  kind: WindowsProcessKind;
  bitness: 32 | 64 | null;
  ownerSid: string | null;
  directory: string | null;
  reason: string | null;
}

/** What the reader returns: the current user's SID and every record. */
export interface WindowsProcessRecords {
  currentSid: string;
  records: WindowsProcessRecord[];
}

/** A well-formed SID string, e.g. `S-1-5-18`; the pattern `windows-acl.mts` keeps private. */
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;

const PROCESS_TIMEOUT_MS = 30_000;
const PROCESS_MAX_BUFFER = 16 * 1024 * 1024;

const KINDS: ReadonlySet<string> = new Set([
  'exited',
  'denied',
  'live',
  'error',
]);

/**
 * The PowerShell program, a constant: no path or process id travels in it. The
 * C# is compiled in place by `Add-Type`, which on Windows PowerShell 5.1 means
 * C# 5, so it uses no newer syntax. Each process is read in one pass:
 *
 * - `OpenProcess` with PROCESS_QUERY_LIMITED_INFORMATION fails with Win32
 *   error 87 for a process that is gone (`exited`) and 5 for a refusal
 *   (`denied`); only a failed `OpenProcess` can be `exited`;
 * - `IsWow64Process2` reports the bitness: any process machine other than
 *   IMAGE_FILE_MACHINE_UNKNOWN is a WOW64 process (32);
 * - `OpenProcessToken` with TOKEN_QUERY reads the owner SID;
 * - for a 64-bit process only, a second open with PROCESS_QUERY_INFORMATION
 *   and PROCESS_VM_READ feeds `NtQueryInformationProcess` (the PEB address)
 *   and `ReadProcessMemory` (PEB.ProcessParameters at +0x20, then the
 *   CurrentDirectory.DosPath UNICODE_STRING at +0x38 of the parameters). A
 *   refusal there (STATUS_ACCESS_DENIED, or Win32 error 5 from the read) is
 *   `denied`, and every other failure is `error`, never `exited`.
 *
 * A 32-bit PowerShell cannot read a 64-bit process's memory, so the program
 * refuses to run there and the whole call fails.
 */
const PROCESS_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ([IntPtr]::Size -ne 8) { throw 'a 64-bit PowerShell is required' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public class IddProcessRecord {
  public string Kind;
  public int Bitness;
  public string OwnerSid;
  public string Directory;
  public string Reason;
}

public static class IddProcessCwd {
  const uint QueryLimited = 0x1000;
  const uint QueryAndRead = 0x0410;
  const uint TokenQuery = 0x0008;
  const int AccessDenied = 5;
  const int InvalidParameter = 87;
  const uint StatusAccessDenied = 0xC0000022;

  [StructLayout(LayoutKind.Sequential)]
  struct BasicInformation {
    public IntPtr ExitStatus;
    public IntPtr PebBaseAddress;
    public IntPtr AffinityMask;
    public IntPtr BasePriority;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int information, IntPtr buffer, int length, out int needed);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int information, ref BasicInformation buffer, int length, out int returned);

  static void Fail(IddProcessRecord record, string reason) {
    record.Kind = "error";
    record.Directory = null;
    record.Reason = reason;
  }

  static void Deny(IddProcessRecord record) {
    record.Kind = "denied";
    record.Bitness = 0;
    record.Directory = null;
    record.Reason = null;
  }

  // Only a failed OpenProcess can mean the process is gone (87).
  static void ClassifyOpen(IddProcessRecord record, int code) {
    if (code == InvalidParameter) {
      record.Kind = "exited";
      record.Bitness = 0;
      record.OwnerSid = null;
      record.Directory = null;
      record.Reason = null;
    } else if (code == AccessDenied) {
      Deny(record);
    } else {
      Fail(record, "OpenProcess failed with Win32 error " + code);
    }
  }

  // A failed read is a refusal (5) or an error, never an exit.
  static void ClassifyRead(IddProcessRecord record, int code) {
    if (code == AccessDenied) {
      Deny(record);
    } else {
      Fail(record, "ReadProcessMemory failed with Win32 error " + code);
    }
  }

  static string ReadOwner(IntPtr process) {
    IntPtr token = IntPtr.Zero;
    IntPtr buffer = IntPtr.Zero;
    try {
      if (!OpenProcessToken(process, TokenQuery, out token)) return null;
      int needed;
      GetTokenInformation(token, 1, IntPtr.Zero, 0, out needed);
      if (needed <= 0) return null;
      buffer = Marshal.AllocHGlobal(needed);
      if (!GetTokenInformation(token, 1, buffer, needed, out needed)) return null;
      return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
    } catch (Exception) {
      return null;
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
    }
  }

  static bool ReadMemory(IntPtr process, long address, byte[] buffer, out int code) {
    UIntPtr read;
    code = 0;
    if (ReadProcessMemory(process, new IntPtr(address), buffer, new UIntPtr((uint)buffer.Length), out read)
        && read.ToUInt64() == (ulong)buffer.Length) {
      return true;
    }
    code = Marshal.GetLastWin32Error();
    return false;
  }

  static void ReadDirectory(IntPtr process, IddProcessRecord record) {
    BasicInformation information = new BasicInformation();
    int returned;
    int status = NtQueryInformationProcess(process, 0, ref information, Marshal.SizeOf(typeof(BasicInformation)), out returned);
    if (unchecked((uint)status) == StatusAccessDenied) {
      Deny(record);
      return;
    }
    if (status != 0) {
      Fail(record, "NtQueryInformationProcess returned 0x" + unchecked((uint)status).ToString("X8"));
      return;
    }
    long peb = information.PebBaseAddress.ToInt64();
    if (peb == 0) {
      Fail(record, "the process has no PEB");
      return;
    }
    int code;
    byte[] pointer = new byte[8];
    if (!ReadMemory(process, peb + 0x20, pointer, out code)) {
      ClassifyRead(record, code);
      return;
    }
    long parameters = BitConverter.ToInt64(pointer, 0);
    if (parameters == 0) {
      Fail(record, "the process has no parameters block");
      return;
    }
    byte[] header = new byte[16];
    if (!ReadMemory(process, parameters + 0x38, header, out code)) {
      ClassifyRead(record, code);
      return;
    }
    int length = BitConverter.ToUInt16(header, 0);
    long address = BitConverter.ToInt64(header, 8);
    if (length == 0 || length % 2 != 0 || address == 0) {
      Fail(record, "the process has no current directory");
      return;
    }
    byte[] text = new byte[length];
    if (!ReadMemory(process, address, text, out code)) {
      ClassifyRead(record, code);
      return;
    }
    string directory = Encoding.Unicode.GetString(text);
    while (directory.Length > 3 && directory[directory.Length - 1] == '\\') {
      directory = directory.Substring(0, directory.Length - 1);
    }
    record.Kind = "live";
    record.Directory = directory;
  }

  public static IddProcessRecord Read(int pid) {
    IddProcessRecord record = new IddProcessRecord();
    IntPtr limited = IntPtr.Zero;
    IntPtr full = IntPtr.Zero;
    try {
      limited = OpenProcess(QueryLimited, false, pid);
      if (limited == IntPtr.Zero) {
        ClassifyOpen(record, Marshal.GetLastWin32Error());
        return record;
      }
      ushort machine;
      ushort native;
      if (!IsWow64Process2(limited, out machine, out native)) {
        Fail(record, "IsWow64Process2 failed with Win32 error " + Marshal.GetLastWin32Error());
        return record;
      }
      record.Bitness = machine != 0 ? 32 : 64;
      record.OwnerSid = ReadOwner(limited);
      if (record.Bitness == 32) {
        record.Kind = "live";
        return record;
      }
      full = OpenProcess(QueryAndRead, false, pid);
      if (full == IntPtr.Zero) {
        ClassifyOpen(record, Marshal.GetLastWin32Error());
        return record;
      }
      ReadDirectory(full, record);
      return record;
    } catch (Exception e) {
      Fail(record, e.GetType().Name + ": " + e.Message);
      return record;
    } finally {
      if (full != IntPtr.Zero) CloseHandle(full);
      if (limited != IntPtr.Zero) CloseHandle(limited);
    }
  }
}
'@
$records = New-Object System.Collections.Generic.List[object]
foreach ($process in Get-Process) {
  if ($process.Id -eq 0) { continue }
  $read = [IddProcessCwd]::Read($process.Id)
  $bitness = $null
  if ($read.Bitness -ne 0) { $bitness = $read.Bitness }
  $records.Add([ordered]@{
    pid = $process.Id
    kind = $read.Kind
    bitness = $bitness
    ownerSid = $read.OwnerSid
    directory = $read.Directory
    reason = $read.Reason
  })
}
$result = [ordered]@{
  currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  records = $records.ToArray()
}
[Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 4 -Compress))
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string, or null when the field is absent or null. Anything else is malformed. */
function optionalString(
  record: Record<string, unknown>,
  field: string,
  index: number,
): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`records[${index}].${field} is not a string or null`);
  }
  return value;
}

function parseRecord(value: unknown, index: number): WindowsProcessRecord {
  if (!isObject(value)) throw new Error(`records[${index}] is not an object`);
  const { pid, kind, bitness: rawBitness } = value;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`records[${index}].pid is not a positive integer`);
  }
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw new Error(`records[${index}].kind is not a known kind`);
  }
  const type = kind as WindowsProcessKind;
  if (
    rawBitness !== undefined &&
    rawBitness !== null &&
    rawBitness !== 32 &&
    rawBitness !== 64
  ) {
    throw new Error(`records[${index}].bitness is not 32, 64, or null`);
  }
  const bitness = rawBitness === 32 || rawBitness === 64 ? rawBitness : null;
  const ownerSid = optionalString(value, 'ownerSid', index);
  const directory = optionalString(value, 'directory', index);
  const reason = optionalString(value, 'reason', index);
  if (type !== 'error' && reason !== null) {
    throw new Error(`records[${index}].reason is set on a ${type} record`);
  }
  if (type === 'exited' || type === 'denied') {
    if (bitness !== null || directory !== null) {
      throw new Error(
        `records[${index}] is ${type} but has a bitness or a directory`,
      );
    }
    if (type === 'exited' && ownerSid !== null) {
      throw new Error(`records[${index}] is exited but has an owner`);
    }
  } else if (type === 'live') {
    if (bitness === null) {
      throw new Error(`records[${index}] is live without a bitness`);
    }
    if (bitness === 64 && (directory === null || directory.trim() === '')) {
      throw new Error(
        `records[${index}] is live and 64-bit without a directory`,
      );
    }
    if (bitness === 32 && directory !== null) {
      throw new Error(`records[${index}] is live and 32-bit with a directory`);
    }
  } else if (reason === null || reason.trim() === '') {
    throw new Error(`records[${index}] is an error without a reason`);
  }
  return { pid, kind: type, bitness, ownerSid, directory, reason };
}

/**
 * Parse the reader's stdout: one JSON object with the current user's SID and
 * an array of records. Anything else throws, so a caller never sees a record
 * of an unknown kind or one whose fields contradict its kind. Unknown fields
 * are ignored.
 */
// audit:ignore-dead-export: consumers arrive in the mapping issue of #5285
export function parseWindowsProcessRecords(
  json: string,
): WindowsProcessRecords {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('the process reader did not print JSON');
  }
  if (!isObject(parsed) || !Array.isArray(parsed.records)) {
    throw new Error('the process reader did not print an object with records');
  }
  const currentSid = parsed.currentSid;
  if (typeof currentSid !== 'string' || !SID_PATTERN.test(currentSid)) {
    throw new Error('the process reader did not print a current user SID');
  }
  const records = (parsed.records as unknown[]).map(parseRecord);
  return { currentSid, records };
}

function system32(env: NodeJS.ProcessEnv): string {
  // An absolute path: a bare name would be resolved against the current
  // directory before PATH on Windows, so a checkout could plant a `powershell`.
  const root = [env.SystemRoot, env.windir].find(
    (candidate) => candidate !== undefined && isAbsolute(candidate),
  );
  return join(root ?? 'C:\\Windows', 'System32');
}

/**
 * Read every process with one System32 PowerShell call. It throws when the
 * call fails (a non-zero exit, a timeout, no PowerShell) or prints anything
 * but the object `parseWindowsProcessRecords` accepts: a read that cannot be
 * trusted is no read, never a partial one.
 */
// audit:ignore-dead-export: consumers arrive in the mapping issue of #5285
export function readWindowsProcessRecords(
  deps: WindowsAclProcessDeps = {},
): WindowsProcessRecords {
  const env = deps.env ?? process.env;
  const exec = (deps.execFile ?? execFileSync) as NonNullable<
    WindowsAclProcessDeps['execFile']
  >;
  const out = exec(
    join(system32(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', PROCESS_SCRIPT],
    {
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: PROCESS_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return parseWindowsProcessRecords(out);
}
