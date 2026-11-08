# dsh-game-preview — window capture helper (Windows, PowerShell 5.1+).
#
# A long-lived child of the Host plugin. Speaks a line protocol on stdin/stdout so
# the Host can enumerate windows and stream JPEG frames of one HWND. The capture
# loop lives in C# compiled at start-up: PowerShell only reads stdin and writes
# the already-finished lines.
#
# stdin :  PING
#          LIST
#          START <hwnd> <fps> <maxWidth> <quality>
#          STOP
#          QUIT
# stdout:  PONG
#          WIN <hwnd> <pid> <w> <h> <base64-utf8-title>
#          END
#          STARTED <w> <h>
#          DATA <seq> <w> <h> <captureMs> <encodeMs> <black 0|1> <base64-jpeg>
#          STAT <fps> <drops> <avgCaptureMs> <avgEncodeMs>
#          ERR <code> <message>
#          STOPPED
#
# Error codes: window-closed | minimized | no-size | printwindow-failed | bad-args
param(
  [int]$DefaultFps = 20,
  [int]$DefaultWidth = 0,
  [int]$DefaultQuality = 70
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $utf8 } catch {}

Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace GpCaptureHost {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public const uint GW_OWNER = 4;

    // DWMWA_EXTENDED_FRAME_BOUNDS = 9 drops the invisible resize border.
    public static RECT Bounds(IntPtr hwnd) {
      RECT r;
      if (DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.Right > r.Left && r.Bottom > r.Top) return r;
      GetWindowRect(hwnd, out r);
      return r;
    }

    public static string Title(IntPtr hwnd) {
      int len = GetWindowTextLength(hwnd);
      if (len <= 0) return string.Empty;
      var sb = new StringBuilder(len + 2);
      GetWindowText(hwnd, sb, sb.Capacity);
      return sb.ToString();
    }

    public static string ClassName(IntPtr hwnd) {
      var sb = new StringBuilder(256);
      GetClassName(hwnd, sb, sb.Capacity);
      return sb.ToString();
    }
  }

  public class WindowRow {
    public long Hwnd; public int Pid; public int W, H; public string Title;
  }

  public sealed class RawFrame {
    public byte[] Pixels; public int W, H, Stride; public long Seq; public long CaptureMs;
  }

  public static class Capture {
    const int POOL = 3;
    static readonly object OutLock = new object();
    static readonly object FrameLock = new object();

    static Thread _capThread, _encThread;
    static volatile bool _running;
    static volatile bool _stop;
    static IntPtr _hwnd;
    static int _fps = 20, _maxWidth, _quality = 70;

    static readonly RawFrame[] _pool = new RawFrame[POOL];
    static RawFrame _pending;
    static long _seq;
    static long _drops;
    static double _sumCapture, _sumEncode; static long _frames;
    static string _lastError;
    static readonly AutoResetEvent FrameReady = new AutoResetEvent(false);

    static ImageCodecInfo _jpeg;
    static EncoderParameters _qualityParam;

    static Capture() {
      foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") _jpeg = c;
      _qualityParam = new EncoderParameters(1);
      _qualityParam.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
    }

    public static void Emit(string line) {
      lock (OutLock) {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
      }
    }

    public static void EmitError(string code, string message) {
      Emit("ERR " + code + " " + (message ?? string.Empty));
    }

    /* ------------------------------------------------------------- listing */

    public static List<WindowRow> List() {
      var rows = new List<WindowRow>();
      Native.EnumWindows((h, l) => {
        if (!Native.IsWindowVisible(h)) return true;
        if (Native.GetWindow(h, Native.GW_OWNER) != IntPtr.Zero) return true;   // owned popups
        if (Native.Title(h).Length == 0) return true;
        uint pid;
        Native.GetWindowThreadProcessId(h, out pid);
        var r = Native.Bounds(h);
        int w = r.Right - r.Left, hh = r.Bottom - r.Top;
        if (w < 80 || hh < 60) return true;                                      // tooltips, trays
        rows.Add(new WindowRow { Hwnd = h.ToInt64(), Pid = (int)pid, W = w, H = hh, Title = Native.Title(h) });
        return true;
      }, IntPtr.Zero);
      return rows;
    }

    static string B64(string text) {
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(text ?? string.Empty));
    }

    public static void PrintList() {
      foreach (var row in List()) {
        Emit("WIN " + row.Hwnd + " " + row.Pid + " " + row.W + " " + row.H + " " + B64(row.Title));
      }
      Emit("END");
    }

    /* ------------------------------------------------------------ controls */

    public static void Start(long hwnd, int fps, int maxWidth, int quality) {
      Stop();
      if (!Native.IsWindow(new IntPtr(hwnd))) { EmitError("window-closed", "hwnd " + hwnd + " is not a window"); return; }
      _hwnd = new IntPtr(hwnd);
      _fps = fps > 0 ? Math.Min(fps, 60) : 20;
      _maxWidth = maxWidth > 0 ? maxWidth : 0;
      _quality = quality >= 10 && quality <= 95 ? quality : 70;
      _seq = 0; _drops = 0; _frames = 0; _sumCapture = 0; _sumEncode = 0; _lastError = null;
      var bounds = Native.Bounds(_hwnd);
      Emit("STARTED " + (bounds.Right - bounds.Left) + " " + (bounds.Bottom - bounds.Top));
      _stop = false;
      _running = true;
      _capThread = new Thread(CaptureLoop) { IsBackground = true, Name = "gp-capture" };
      _encThread = new Thread(EncodeLoop) { IsBackground = true, Name = "gp-encode" };
      _capThread.Start();
      _encThread.Start();
    }

    public static void Stop() {
      if (!_running) return;
      _stop = true;
      _running = false;
      FrameReady.Set();
      var cap = _capThread; var enc = _encThread;
      try { if (cap != null) cap.Join(1500); } catch {}
      try { if (enc != null) enc.Join(1500); } catch {}
      _capThread = null; _encThread = null;
      lock (FrameLock) { _pending = null; }
      Emit("STOPPED");
    }

    /* ---------------------------------------------------------- input */

    public static void Pointer(long hwnd, string action, double nx, double ny, string button) {
      var target = new IntPtr(hwnd);
      if (!Native.IsWindow(target)) return;
      var bounds = Native.Bounds(target);
      int x = bounds.Left + (int)Math.Round(nx * (bounds.Right - bounds.Left));
      int y = bounds.Top + (int)Math.Round(ny * (bounds.Bottom - bounds.Top));
      if (action == "move") {
        Native.SetCursorPos(x, y);
        return;
      }
      var fg = Native.SetForegroundWindow(target);
      Native.SetCursorPos(x, y);
      string side = string.IsNullOrEmpty(button) ? "left" : button.ToLowerInvariant();
      uint down = side == "right" ? Native.MOUSEEVENTF_RIGHTDOWN
        : side == "middle" ? Native.MOUSEEVENTF_MIDDLEDOWN
        : Native.MOUSEEVENTF_LEFTDOWN;
      uint up = side == "right" ? Native.MOUSEEVENTF_RIGHTUP
        : side == "middle" ? Native.MOUSEEVENTF_MIDDLEUP
        : Native.MOUSEEVENTF_LEFTUP;
      Native.mouse_event(action == "down" ? down : up, 0, 0, 0, IntPtr.Zero);
      if (!fg) Emit("NOTICE foreground-failed");
    }

    public static void Wheel(int delta) {
      Native.mouse_event(Native.MOUSEEVENTF_WHEEL, 0, 0, delta, IntPtr.Zero);
    }

    public static void Key(int vk, bool down) {
      Native.keybd_event((byte)vk, 0, down ? 0u : Native.KEYEVENTF_KEYUP, IntPtr.Zero);
    }

    public static void Quit() {
      _stop = true;
      _running = false;
      FrameReady.Set();
      var cap2 = _capThread; var enc2 = _encThread;
      try { if (cap2 != null) cap2.Join(800); } catch {}
      try { if (enc2 != null) enc2.Join(800); } catch {}
    }

    /* --------------------------------------------------------------- loops */

    static RawFrame TakeBuffer(int bytes) {
      lock (FrameLock) {
        for (int i = 0; i < POOL; i++) {
          if (_pool[i] != null && ReferenceEquals(_pool[i], _pending)) continue;
          if (_pool[i] != null && _pool[i].Pixels != null && _pool[i].Pixels.Length >= bytes) return _pool[i];
        }
        var fresh = new RawFrame { Pixels = new byte[bytes] };
        int slot = Array.FindIndex(_pool, x => x == null);
        if (slot >= 0) _pool[slot] = fresh;
        return fresh;
      }
    }

    static void CaptureLoop() {
      var interval = 1000.0 / Math.Max(1, _fps);
      while (!_stop) {
        var tick = Stopwatch.StartNew();
        if (!Native.IsWindow(_hwnd)) { ReportError("window-closed", "the window is gone"); break; }
        if (Native.IsIconic(_hwnd)) { ReportError("minimized", "the window is minimized"); Thread.Sleep(250); continue; }

        var bounds = Native.Bounds(_hwnd);
        int w = bounds.Right - bounds.Left, h = bounds.Bottom - bounds.Top;
        if (w <= 0 || h <= 0) { ReportError("no-size", "the window has no size"); Thread.Sleep(250); continue; }

        var frame = TakeBuffer(w * h * 4);
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
          var sw = Stopwatch.StartNew();
          bool ok;
          using (var g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            ok = Native.PrintWindow(_hwnd, hdc, 2);   // PW_RENDERFULLCONTENT
            g.ReleaseHdc(hdc);
          }
          if (!ok) { ReportError("printwindow-failed", "PrintWindow returned false"); Thread.Sleep(250); continue; }
          frame.CaptureMs = sw.ElapsedMilliseconds;

          var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
          int stride = data.Stride;
          int bytes = stride * h;
          if (frame.Pixels.Length < bytes) frame.Pixels = new byte[bytes];
          Marshal.Copy(data.Scan0, frame.Pixels, 0, bytes);
          bmp.UnlockBits(data);
          frame.W = w; frame.H = h; frame.Stride = stride;
        }

        if (frame.CaptureMs == 0) frame.CaptureMs = 1;
        frame.Seq = Interlocked.Increment(ref _seq);
        lock (FrameLock) {
          if (_pending != null) _drops++;              // encoder still busy: newest frame wins
          _pending = frame;
        }
        FrameReady.Set();
        _lastError = null;

        double rest = interval - tick.Elapsed.TotalMilliseconds;
        if (rest > 1) Thread.Sleep((int)rest);
      }
    }

    static void ReportError(string code, string message) {
      if (_lastError == code) return;
      _lastError = code;
      EmitError(code, message);
    }

    static void EncodeLoop() {
      while (!_stop) {
        RawFrame frame;
        lock (FrameLock) {
          frame = _pending;
          _pending = null;
        }
        if (frame == null) { FrameReady.WaitOne(120); continue; }
        try {
          Encode(frame);
        } catch (Exception ex) {
          EmitError("encode-failed", ex.Message.Replace('\n', ' '));
        }
      }
    }

    static void Encode(RawFrame frame) {
      var sw = Stopwatch.StartNew();
      int w = frame.W, h = frame.H, stride = frame.Stride;
      byte[] outBytes;
      int outW = w, outH = h;
      bool black;

      using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        Marshal.Copy(frame.Pixels, 0, data.Scan0, Math.Min(frame.Pixels.Length, stride * h));
        bmp.UnlockBits(data);

        black = IsBlack(frame, w, h, stride);

        Bitmap target = bmp;
        try {
          if (_maxWidth > 0 && w > _maxWidth) {
            double scale = _maxWidth / (double)w;
            outW = Math.Max(1, (int)Math.Round(w * scale));
            outH = Math.Max(1, (int)Math.Round(h * scale));
            target = new Bitmap(outW, outH, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(target)) {
              g.InterpolationMode = InterpolationMode.Bilinear;
              g.PixelOffsetMode = PixelOffsetMode.HighSpeed;
              g.CompositingQuality = CompositingQuality.HighSpeed;
              g.DrawImage(bmp, 0, 0, outW, outH);
            }
          } else {
            outW = w; outH = h;
          }
          _qualityParam.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)_quality);
          using (var ms = new MemoryStream()) {
            target.Save(ms, _jpeg, _qualityParam);
            outBytes = ms.ToArray();
          }
        } finally {
          if (!ReferenceEquals(target, bmp)) target.Dispose();
        }
      }

      long encodeMs = sw.ElapsedMilliseconds;
      _frames++;
      _sumCapture += frame.CaptureMs;
      _sumEncode += encodeMs;
      Emit("DATA " + frame.Seq + " " + outW + " " + outH + " " + frame.CaptureMs + " " + encodeMs + " " + (black ? "1" : "0") + " " + Convert.ToBase64String(outBytes));

      if (_frames % 20 == 0) {
        Emit("STAT " + _frames + " " + _drops + " " + (long)(_sumCapture / _frames) + " " + (long)(_sumEncode / _frames));
      }
    }

    static bool IsBlack(RawFrame frame, int w, int h, int stride) {
      int stepY = Math.Max(1, h / 24), stepX = Math.Max(1, w / 32);
      int black = 0, samples = 0;
      for (int y = 0; y < h; y += stepY) {
        int row = y * stride;
        for (int x = 0; x < w; x += stepX) {
          int px = row + x * 4;
          samples++;
          if (frame.Pixels[px] < 8 && frame.Pixels[px + 1] < 8 && frame.Pixels[px + 2] < 8) black++;
        }
      }
      return samples > 0 && black > samples * 0.985;
    }
  }
}
'@

# ---------------------------------------------------------------- stdin loop

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  $parts = $line.Split(' ')
  $cmd = $parts[0].ToUpperInvariant()
  try {
    switch ($cmd) {
      'PING' { [GpCaptureHost.Capture]::Emit('PONG') }
      'LIST' { [GpCaptureHost.Capture]::PrintList() }
      'START' {
        if ($parts.Length -lt 2) { [GpCaptureHost.Capture]::EmitError('bad-args', 'START needs an hwnd'); break }
        $hwnd = [int64]$parts[1]
        $fps = if ($parts.Length -gt 2) { [int]$parts[2] } else { $DefaultFps }
        $width = if ($parts.Length -gt 3) { [int]$parts[3] } else { $DefaultWidth }
        $quality = if ($parts.Length -gt 4) { [int]$parts[4] } else { $DefaultQuality }
        [GpCaptureHost.Capture]::Start($hwnd, $fps, $width, $quality)
      }
      'STOP' { [GpCaptureHost.Capture]::Stop() }
      'MOVE' {
        [GpCaptureHost.Capture]::Pointer([int64]$parts[1], 'move', [double]$parts[2], [double]$parts[3], '')
      }
      'BUTTON' {
        [GpCaptureHost.Capture]::Pointer([int64]$parts[1], $parts[2].ToLowerInvariant(), [double]$parts[3], [double]$parts[4], $(if ($parts.Length -gt 5) { $parts[5] } else { 'left' }))
      }
      'WHEEL' { [GpCaptureHost.Capture]::Wheel([int]$parts[1]) }
      'KEY' { [GpCaptureHost.Capture]::Key([int]$parts[1], $parts[2] -eq '1') }
      'QUIT' { [GpCaptureHost.Capture]::Quit(); break }
      default { [GpCaptureHost.Capture]::EmitError('bad-args', "unknown command: $cmd") }
    }
  } catch {
    [GpCaptureHost.Capture]::EmitError('helper-failed', "$($_.Exception.Message -replace "`n", ' ')")
  }
  if ($cmd -eq 'QUIT') { break }
}
