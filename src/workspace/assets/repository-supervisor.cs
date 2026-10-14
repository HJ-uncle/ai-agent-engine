using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// A job contains Git before its first instruction. Descendants cannot escape
// with CREATE_BREAKAWAY_FROM_JOB: no breakaway limit is enabled on this job.
public static class AetherRepositorySupervisor {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
  static IntPtr Job, Owner;
  static string JobName, OwnerBirth, SupervisorBirth, Receipt;
  static int OwnerPid, SupervisorPid;
  static readonly object OutputGate = new object();
  static StreamReader Input;
  static StreamWriter Output;
  static long Birth(IntPtr process) { long creation, exit, kernel, user; if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) throw new Win32Exception(); return creation; }
  static IntPtr ProcessHandle(int pid) { return OpenProcess(0x00100000 | 0x1000, false, pid); }
  static bool Alive(IntPtr handle) { return handle != IntPtr.Zero && WaitForSingleObject(handle, 0) == 258; }
  static bool OriginalAlive(int pid, string birth) { var handle = ProcessHandle(pid); try { if (handle == IntPtr.Zero) { if (Marshal.GetLastWin32Error() == 87) return false; throw new Win32Exception(); } return Birth(handle).ToString() == birth && Alive(handle); } finally { if (handle != IntPtr.Zero) CloseHandle(handle); } }
  static void Emit(object value) { lock (OutputGate) { try { Output.WriteLine(Json.Serialize(value)); Output.Flush(); } catch(IOException) { /* Owner pipe can close before native cleanup writes its durable receipt. */ } } }
  static int Active(IntPtr job) { var info = new BasicAccounting(); int size; if (!QueryInformationJobObject(job, 1, ref info, Marshal.SizeOf(typeof(BasicAccounting)), out size)) throw new Win32Exception(); return (int)info.ActiveProcesses; }
  static int[] Members(IntPtr job) {
    int bytes = 8 + 4096 * IntPtr.Size; IntPtr block = Marshal.AllocHGlobal(bytes);
    try { int size; if (!QueryInformationJobObject(job, 3, block, bytes, out size)) throw new Win32Exception(); int count = Marshal.ReadInt32(block, 4); var members = new int[count]; for(int i = 0; i < count; i++) members[i] = Marshal.ReadIntPtr(block, 8 + i * IntPtr.Size).ToInt32(); return members; }
    finally { Marshal.FreeHGlobal(block); }
  }
  static object MemberEvidence(IntPtr job) { var result = new List<object>(); foreach(int pid in Members(job)) { var handle = ProcessHandle(pid); try { if(handle != IntPtr.Zero) result.Add(new { pid, birth = Birth(handle).ToString() }); } finally { if(handle != IntPtr.Zero) CloseHandle(handle); } } return result; }
  static bool Drain(IntPtr job, int milliseconds) { var deadline = Stopwatch.StartNew(); while(Active(job) != 0 && deadline.ElapsedMilliseconds < milliseconds) Thread.Sleep(10); return Active(job) == 0; }
  static string ExtendedPath(string value) {
    if(value.StartsWith(@"\\?\",StringComparison.Ordinal))return value;
    if(value.StartsWith(@"\\",StringComparison.Ordinal))return @"\\?\UNC\"+value.Substring(2);
    return @"\\?\"+value;
  }
  static bool ExistsLong(string value) {
    uint attributes=GetFileAttributesW(ExtendedPath(value));
    if(attributes!=0xffffffff)return true;
    int error=Marshal.GetLastWin32Error();if(error==2 || error==3)return false;throw new Win32Exception(error);
  }
  static void SaveClosure() {
    if(Job==IntPtr.Zero || Active(Job)!=0 || Receipt==null) throw new Exception("Native closure cannot certify live processes");
    var bytes=Encoding.UTF8.GetBytes(Json.Serialize(new {protocol="windows-job-v1",jobName=JobName,ownerPid=OwnerPid,ownerBirth=OwnerBirth,supervisorPid=SupervisorPid,supervisorBirth=SupervisorBirth,activeProcesses=0,closedAtUtc=DateTime.UtcNow.ToString("o")})+"\n");
    string temporary=Receipt+"."+SupervisorPid+".tmp";
    // .NET Framework path APIs can silently report a long cancel path absent,
    // or reject a closure receipt after the job is already stopped. Use the
    // Unicode Win32 namespace for both operations, retaining create-new rules.
    var handle=CreateFileW(ExtendedPath(temporary),0x40000000,0,IntPtr.Zero,1,0x80,IntPtr.Zero);
    if(handle==new IntPtr(-1))throw new Win32Exception();
    using(var output=new FileStream(new SafeFileHandle(handle,true),FileAccess.Write)){output.Write(bytes,0,bytes.Length);output.Flush(true);}
    if(!MoveFileW(ExtendedPath(temporary),ExtendedPath(Receipt)))throw new Win32Exception();
  }
  static string Quote(string value) {
    if(value.Length > 0 && value.IndexOfAny(new[] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
    var output = new StringBuilder("\""); int slashes=0;
    foreach(char item in value) { if(item == '\\') { slashes++; continue; } if(item == '"') output.Append('\\', slashes*2+1); else output.Append('\\', slashes); slashes=0; output.Append(item); }
    output.Append('\\', slashes*2); return output.Append('"').ToString();
  }
  static string String(Dictionary<string,object> request, string name) { return (string)request[name]; }
  static int Number(Dictionary<string,object> request, string name) { return Convert.ToInt32(request[name]); }
  static void Run(Dictionary<string,object> request) {
    if(!Alive(Owner)) throw new Exception("Owner exited before dispatch");
    var security = new Security { Length = Marshal.SizeOf(typeof(Security)), Inherit = true };
    IntPtr stdinRead=IntPtr.Zero,stdinWrite=IntPtr.Zero,stdoutRead=IntPtr.Zero,stdoutWrite=IntPtr.Zero,stderrRead=IntPtr.Zero,stderrWrite=IntPtr.Zero;
    ProcessInfo process = new ProcessInfo(); IntPtr environment = IntPtr.Zero; string failure = null; int exitCode=-1; bool empty=false; bool killed=false;
    var members = new List<object>(); var stdout = new MemoryStream(); var stderr = new MemoryStream(); Task outputTask = null, errorTask = null, inputTask = null;
    try {
      if(!CreatePipe(out stdinRead,out stdinWrite,ref security,0) || !CreatePipe(out stdoutRead,out stdoutWrite,ref security,0) || !CreatePipe(out stderrRead,out stderrWrite,ref security,0)) throw new Win32Exception();
      if(!SetHandleInformation(stdinWrite,1,0) || !SetHandleInformation(stdoutRead,1,0) || !SetHandleInformation(stderrRead,1,0)) throw new Win32Exception();
      var startup = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Flags=0x100, StdInput=stdinRead,StdOutput=stdoutWrite,StdError=stderrWrite };
      var line = new StringBuilder(Quote(String(request,"file"))); foreach(object arg in (System.Collections.IEnumerable)request["args"]) line.Append(" ").Append(Quote((string)arg));
      var values = (Dictionary<string,object>)request["env"]; var names = new List<string>(values.Keys); names.Sort(StringComparer.OrdinalIgnoreCase); var block = new StringBuilder();
      foreach(string name in names) block.Append(name).Append('=').Append((string)values[name]).Append('\0'); block.Append('\0'); environment=Marshal.StringToHGlobalUni(block.ToString());
      if(!CreateProcessW(String(request,"file"),line,IntPtr.Zero,IntPtr.Zero,true,0x4 | 0x400 | 0x08000000,environment,String(request,"cwd"),ref startup,out process)) throw new Win32Exception();
      // Assignment failure is closed: the suspended process never runs.
      if(!AssignProcessToJobObject(Job,process.Process)) { TerminateProcess(process.Process,127); WaitForSingleObject(process.Process,10000); throw new Win32Exception(); }
      members.Add(MemberEvidence(Job));
      CloseHandle(stdinRead); stdinRead=IntPtr.Zero; CloseHandle(stdoutWrite); stdoutWrite=IntPtr.Zero; CloseHandle(stderrWrite); stderrWrite=IntPtr.Zero;
      var outputPipe = new FileStream(new SafeFileHandle(stdoutRead,true),FileAccess.Read); stdoutRead=IntPtr.Zero;
      var errorPipe = new FileStream(new SafeFileHandle(stderrRead,true),FileAccess.Read); stderrRead=IntPtr.Zero;
      var inputPipe = new FileStream(new SafeFileHandle(stdinWrite,true),FileAccess.Write); stdinWrite=IntPtr.Zero;
      int overflow=0; int max=Number(request,"maxBytes");
      bool streamStderr=request.ContainsKey("streamStderr") && (bool)request["streamStderr"];
      Action<FileStream,MemoryStream,bool> read = (pipe, buffer, isError) => { using(pipe) { var bytes=new byte[8192]; int count; while((count=pipe.Read(bytes,0,bytes.Length)) > 0) { if(buffer.Length + count > max) Interlocked.Exchange(ref overflow,1); else buffer.Write(bytes,0,count); if(isError && streamStderr)Emit(new{kind="stderr",id=request["id"],data=Convert.ToBase64String(bytes,0,count)}); } } };
      outputTask=Task.Run(()=>read(outputPipe,stdout,false)); errorTask=Task.Run(()=>read(errorPipe,stderr,true));
      byte[] input=Convert.FromBase64String(String(request,"input")); inputTask=Task.Run(()=> { using(inputPipe) { try { inputPipe.Write(input,0,input.Length); } catch(IOException) { /* Child may reject input early; its exit remains authoritative. */ } } });
      if(ResumeThread(process.Thread) == 0xffffffff) throw new Win32Exception(); CloseHandle(process.Thread); process.Thread=IntPtr.Zero;
      var clock=Stopwatch.StartNew(); int timeout=Number(request,"timeoutMs");
      while(WaitForSingleObject(process.Process,20)==258) {
        if(!Alive(Owner)) { failure="owner-exited"; break; }
        if(request.ContainsKey("cancelPath") && ExistsLong(String(request,"cancelPath"))) { failure="cancelled"; break; }
        if(Volatile.Read(ref overflow)!=0) { failure="output-limit"; break; }
        if(clock.ElapsedMilliseconds >= timeout) { failure="timeout"; break; }
      }
      members.Add(MemberEvidence(Job));
      if(failure != null || Active(Job) != 0) { killed=true; if(!TerminateJobObject(Job,124)) throw new Win32Exception(); }
      empty=Drain(Job,10000);
      if(!empty) failure="process-scope-not-empty";
      uint result; if(GetExitCodeProcess(process.Process,out result)) exitCode=(int)result;
      if(empty && !Task.WaitAll(new[]{outputTask,errorTask,inputTask},10000)) { failure="pipe-drain-unconfirmed"; empty=false; }
      if(Volatile.Read(ref overflow)!=0) failure="output-limit";
    } catch(Exception error) {
      failure=error.ToString();
      if(Job != IntPtr.Zero) { TerminateJobObject(Job,125); empty=Drain(Job,10000); }
    } finally {
      foreach(var handle in new[]{stdinRead,stdinWrite,stdoutRead,stdoutWrite,stderrRead,stderrWrite,process.Process,process.Thread}) if(handle!=IntPtr.Zero) CloseHandle(handle);
      if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment);
    }
    Emit(new {kind="result", id=request["id"], exitCode, stdout=Convert.ToBase64String(stdout.ToArray()),stderr=Convert.ToBase64String(stderr.ToArray()),failure, audit=new{jobName=String(request,"jobName"),empty,activeProcesses=Active(Job),killed,members}});
    if(!empty) throw new Exception("Repository process scope could not be audited empty");
  }
  public static int Main(string[] args) {
    try {
      // DETACHED_PROCESS has redirected pipes but no console. Console encoding
      // setters require a console handle and fail before its watchdog starts.
      Input=new StreamReader(new FileStream(new SafeFileHandle(GetStdHandle(-10),false),FileAccess.Read),new UTF8Encoding(false));
      Output=new StreamWriter(new FileStream(new SafeFileHandle(GetStdHandle(-11),false),FileAccess.Write),new UTF8Encoding(false));
      if(args[0]=="identity") { var handle=ProcessHandle(int.Parse(args[1])); try { if(handle==IntPtr.Zero) throw new Win32Exception(); Emit(new{pid=int.Parse(args[1]),birth=Birth(handle).ToString(),alive=Alive(handle)}); return 0; } finally { if(handle!=IntPtr.Zero) CloseHandle(handle); } }
      if(args[0]=="audit") {
        bool ownerAlive=OriginalAlive(int.Parse(args[2]),args[3]); bool supervisorAlive=args[4]!="0" && OriginalAlive(int.Parse(args[4]),args[5]);
        var job=OpenJobObjectW(0x4,false,args[1]); int error=Marshal.GetLastWin32Error();
        try { if(job==IntPtr.Zero && error!=2) throw new Win32Exception(error); int active=job==IntPtr.Zero?0:Active(job); Emit(new{ownerAlive,supervisorAlive,jobExists=job!=IntPtr.Zero,activeProcesses=active,empty=active==0,verified=!ownerAlive&&!supervisorAlive&&job==IntPtr.Zero}); return 0; }
        finally { if(job!=IntPtr.Zero) CloseHandle(job); }
      }
      JobName=args[1];OwnerPid=int.Parse(args[2]);OwnerBirth=args[3];Receipt=args[4];SupervisorPid=Process.GetCurrentProcess().Id;
      Owner=ProcessHandle(OwnerPid); if(Owner==IntPtr.Zero || Birth(Owner).ToString()!=OwnerBirth || !Alive(Owner)) throw new Exception("Original owner is unavailable");
      Job=CreateJobObjectW(IntPtr.Zero,JobName); int createError=Marshal.GetLastWin32Error(); if(Job==IntPtr.Zero) throw new Win32Exception(); if(createError==183) throw new Exception("Job generation already exists");
      var limits=new ExtendedLimit(); limits.Basic.Flags=0x2000; if(!SetInformationJobObject(Job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimit)))) throw new Win32Exception();
      var self=ProcessHandle(SupervisorPid); try { SupervisorBirth=Birth(self).ToString();Emit(new{kind="ready",pid=SupervisorPid,birth=SupervisorBirth,jobName=JobName}); } finally { CloseHandle(self); }
      Task<string> input=Task.Run(()=>Input.ReadLine());
      while(Alive(Owner)) {
        if(!input.Wait(50)) continue; string line=input.Result; if(line==null) break;
        var request=Json.Deserialize<Dictionary<string,object>>(line); if((string)request["op"]=="close") break; Run(request);
        input=Task.Run(()=>Input.ReadLine());
      }
      if(!TerminateJobObject(Job,126) || !Drain(Job,10000)) throw new Exception("Close could not confirm an empty job");
      SaveClosure();Emit(new{kind="closed",empty=true,activeProcesses=0}); return 0;
    } catch(Exception error) { Emit(new{kind="fatal",message=error.ToString()}); return 1; }
    finally {
      if(Job!=IntPtr.Zero) {
        try { if(Receipt!=null && SupervisorBirth!=null && !ExistsLong(Receipt) && TerminateJobObject(Job,127) && Drain(Job,10000))SaveClosure(); } catch { /* Failed proof is retained as an unrecoverable/quarantined lease. */ }
        CloseHandle(Job);
      }
      if(Owner!=IntPtr.Zero) CloseHandle(Owner);
    }
  }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public int Size; public string Reserved,Desktop,Title; public int X,Y,XSize,YSize,XCountChars,YCountChars,FillAttribute,Flags; public short ShowWindow,ReservedSize; public IntPtr ReservedData,StdInput,StdOutput,StdError; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public int ProcessId,ThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long PerProcess,PerJob; public uint Flags; public UIntPtr MinWorking,MaxWorking; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadCount,WriteCount,OtherCount,ReadTransfer,WriteTransfer,OtherTransfer; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct BasicAccounting { public long TotalUser,TotalKernel,ThisUser,ThisKernel; public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint rights,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int name);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint GetFileAttributesW(string name);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool MoveFileW(string from,string to);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security security,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObjectW(uint rights,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimit info,int bytes);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,ref BasicAccounting info,int bytes,out int returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,IntPtr info,int bytes,out int returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
}
