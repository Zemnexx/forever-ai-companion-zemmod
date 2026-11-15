// Forever AI Companion microphone helper (voice questions). Compiled on the
// player's PC with the C# compiler included in Windows (.NET Framework 4),
// like the tray icon:
//   csc /target:winexe /out:ForeverAICompanionMic.exe Mic.cs
//
// It only captures audio; deciding when a question ends happens in the app
// (src/talk.js). Commands on stdin, one per line:
//   start   beep, open the default microphone and stream what it hears
//   stop    close the microphone (sends what was left), lower beep
//   quit    close everything and exit
// Lines on stdout:
//   ready | started | pcm <base64 of 16 kHz mono 16-bit samples> | stopped | error <text>
//
// The microphone is open only between "start" and "stop". If the app goes
// away (stdin closes), the helper closes the microphone and exits.
using System;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Threading;

[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace ForeverAICompanion.Mic
{
    static class Program
    {
        const int Rate = 16000;
        const int BufferMs = 100;
        const int BufferCount = 4;
        const int WaveMapper = -1;
        const uint WhdrDone = 1;

        [StructLayout(LayoutKind.Sequential)]
        struct WaveFormatEx
        {
            public ushort wFormatTag, nChannels;
            public uint nSamplesPerSec, nAvgBytesPerSec;
            public ushort nBlockAlign, wBitsPerSample, cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct WaveHdr
        {
            public IntPtr lpData;
            public uint dwBufferLength, dwBytesRecorded;
            public IntPtr dwUser;
            public uint dwFlags, dwLoops;
            public IntPtr lpNext, reserved;
        }

        [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr handle, int deviceId, ref WaveFormatEx format, IntPtr callback, IntPtr instance, int flags);
        [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr handle, IntPtr header, int size);
        [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr handle, IntPtr header, int size);
        [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr handle, IntPtr header, int size);
        [DllImport("winmm.dll")] static extern int waveInStart(IntPtr handle);
        [DllImport("winmm.dll")] static extern int waveInReset(IntPtr handle);
        [DllImport("winmm.dll")] static extern int waveInClose(IntPtr handle);

        static readonly object outLock = new object();
        static volatile bool stopRequested;
        static Thread worker;

        static void Send(string line)
        {
            lock (outLock)
            {
                try { Console.Out.WriteLine(line); Console.Out.Flush(); } catch { }
            }
        }

        // A short sine tone with soft edges, played through the default output.
        static void Beep(double hz, int ms)
        {
            try
            {
                int samples = Rate * ms / 1000;
                var wav = new MemoryStream();
                var w = new BinaryWriter(wav);
                w.Write(new[] { 'R', 'I', 'F', 'F' }); w.Write(36 + samples * 2);
                w.Write(new[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' }); w.Write(16);
                w.Write((short)1); w.Write((short)1); w.Write(Rate); w.Write(Rate * 2); w.Write((short)2); w.Write((short)16);
                w.Write(new[] { 'd', 'a', 't', 'a' }); w.Write(samples * 2);
                int fade = Rate / 100;
                for (int i = 0; i < samples; i++)
                {
                    double edge = Math.Min(1.0, Math.Min(i, samples - 1 - i) / (double)fade);
                    w.Write((short)(Math.Sin(2 * Math.PI * hz * i / Rate) * 9000 * edge));
                }
                w.Flush();
                wav.Position = 0;
                using (var player = new SoundPlayer(wav)) player.PlaySync();
            }
            catch { /* no sound device: recording still works */ }
        }

        static void Record()
        {
            var format = new WaveFormatEx
            {
                wFormatTag = 1, nChannels = 1, nSamplesPerSec = Rate, nAvgBytesPerSec = Rate * 2,
                nBlockAlign = 2, wBitsPerSample = 16, cbSize = 0,
            };
            IntPtr handle;
            int rc = waveInOpen(out handle, WaveMapper, ref format, IntPtr.Zero, IntPtr.Zero, 0);
            if (rc != 0)
            {
                Send("error open " + rc);
                return;
            }
            int headerSize = Marshal.SizeOf(typeof(WaveHdr));
            int flagsOffset = (int)Marshal.OffsetOf(typeof(WaveHdr), "dwFlags");
            int recordedOffset = (int)Marshal.OffsetOf(typeof(WaveHdr), "dwBytesRecorded");
            int bytes = Rate * 2 * BufferMs / 1000;
            var headers = new IntPtr[BufferCount];
            var data = new IntPtr[BufferCount];
            try
            {
                for (int i = 0; i < BufferCount; i++)
                {
                    data[i] = Marshal.AllocHGlobal(bytes);
                    headers[i] = Marshal.AllocHGlobal(headerSize);
                    var h = new WaveHdr { lpData = data[i], dwBufferLength = (uint)bytes };
                    Marshal.StructureToPtr(h, headers[i], false);
                    waveInPrepareHeader(handle, headers[i], headerSize);
                    waveInAddBuffer(handle, headers[i], headerSize);
                }
                rc = waveInStart(handle);
                if (rc != 0)
                {
                    Send("error start " + rc);
                    return;
                }
                Send("started");
                var chunk = new byte[bytes];
                int next = 0;
                bool resetDone = false;
                while (true)
                {
                    if (stopRequested && !resetDone)
                    {
                        waveInReset(handle); // marks every queued buffer done
                        resetDone = true;
                    }
                    uint flags = (uint)Marshal.ReadInt32(headers[next], flagsOffset);
                    if ((flags & WhdrDone) == 0)
                    {
                        if (resetDone) break;
                        Thread.Sleep(10);
                        continue;
                    }
                    int got = Marshal.ReadInt32(headers[next], recordedOffset);
                    if (got > 0)
                    {
                        if (chunk.Length != got) chunk = new byte[got];
                        Marshal.Copy(data[next], chunk, 0, got);
                        Send("pcm " + Convert.ToBase64String(chunk));
                    }
                    if (resetDone)
                    {
                        Marshal.WriteInt32(headers[next], flagsOffset, (int)(flags & ~WhdrDone));
                    }
                    else
                    {
                        waveInUnprepareHeader(handle, headers[next], headerSize);
                        Marshal.WriteInt32(headers[next], recordedOffset, 0);
                        Marshal.WriteInt32(headers[next], flagsOffset, 0);
                        waveInPrepareHeader(handle, headers[next], headerSize);
                        waveInAddBuffer(handle, headers[next], headerSize);
                    }
                    next = (next + 1) % BufferCount;
                }
            }
            finally
            {
                waveInReset(handle);
                for (int i = 0; i < BufferCount; i++)
                {
                    if (headers[i] != IntPtr.Zero) { waveInUnprepareHeader(handle, headers[i], headerSize); Marshal.FreeHGlobal(headers[i]); }
                    if (data[i] != IntPtr.Zero) Marshal.FreeHGlobal(data[i]);
                }
                waveInClose(handle);
            }
        }

        static void StopRecording()
        {
            if (worker == null) return;
            stopRequested = true;
            worker.Join(3000);
            worker = null;
        }

        static void Main()
        {
            Send("ready");
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string cmd = line.Trim();
                if (cmd == "start")
                {
                    if (worker != null) continue;
                    Beep(880, 120);
                    stopRequested = false;
                    worker = new Thread(Record) { IsBackground = true };
                    worker.Start();
                }
                else if (cmd == "stop")
                {
                    bool was = worker != null;
                    StopRecording();
                    if (was) { Send("stopped"); Beep(560, 90); }
                }
                else if (cmd == "quit")
                {
                    break;
                }
            }
            StopRecording();
        }
    }
}
