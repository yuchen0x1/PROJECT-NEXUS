param([Parameter(Mandatory=$true)][string]$SpecBase64)
$ErrorActionPreference = 'Stop'
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SpecBase64)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class NexusJobRunner {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  public static int Run(string file, string args, string cwd, int parentPid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("Job creation failed");
    var limits = new Limits(); limits.Basic.Flags = 0x2000 | 0x8 | 0x200; // kill on close, process count, job memory
    limits.Basic.ActiveProcesses = 64; limits.JobMemory = new UIntPtr(2147483648UL);
    int size = Marshal.SizeOf(limits); IntPtr ptr = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, ptr, false);
      if (!SetInformationJobObject(job, 9, ptr, (uint)size)) throw new Exception("Job limits failed");
      var parent = Process.GetProcessById(parentPid);
      var info = new ProcessStartInfo(file, args) { WorkingDirectory=cwd, UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true };
      using (var child = Process.Start(info)) {
        if (!AssignProcessToJobObject(job, child.Handle)) { try { child.Kill(); } catch {} throw new Exception("Job assignment failed"); }
        // Closing the host's process handle notification terminates the entire assigned tree.
        Task.Run(() => { try { parent.WaitForExit(); Environment.Exit(125); } catch { Environment.Exit(125); } });
        var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        child.WaitForExit(); Task.WaitAll(stdout, stderr); return child.ExitCode;
      }
    } finally { Marshal.FreeHGlobal(ptr); CloseHandle(job); }
  }
}
'@
exit [NexusJobRunner]::Run($spec.file, $spec.arguments, $spec.cwd, [int]$spec.parentPid)
