// Forever AI Companion silent "voice": a SAPI 5 text-to-speech engine that
// produces no sound. When the game asks Windows to read text aloud with this
// voice, the text is handed to the app instead (as a file in its data folder).
//
// Built with the C# compiler included in Windows (.NET Framework 4):
//   csc /target:library /out:ForeverAICompanionTts.dll ForeverAICompanionTts.cs
// and registered as a COM class + a SAPI voice token (see src/tts-voice.js).
// The class GUID never changes, so re-registering just updates the voice.
//
// The voice is listed system-wide, so any program can speak with it, and an
// elevated one may load it too. Because of that:
//  - only the app's own messages are handed over (requests and the addon's
//    voice test); any other text is dropped and never written or logged;
//  - nothing is written through a link (junction or symlink) planted in the
//    data folder, which could send an elevated program's writes elsewhere.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace ForeverAICompanion.Tts
{
    [ComImport, Guid("5B559F40-E952-11D2-BB91-00C04F8EE6C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISpObjectWithToken
    {
        [PreserveSig] int SetObjectToken(IntPtr pToken);
        [PreserveSig] int GetObjectToken(out IntPtr ppToken);
    }

    [ComImport, Guid("A74D7C8E-4CC5-4F2F-A6EB-804DEE18500E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISpTTSEngine
    {
        [PreserveSig] int Speak(uint dwSpeakFlags, ref Guid rguidFormatId, IntPtr pWaveFormatEx, IntPtr pTextFragList, IntPtr pOutputSite);
        [PreserveSig] int GetOutputFormat(IntPtr pTargetFmtId, IntPtr pTargetWaveFormatEx, out Guid pOutputFormatId, out IntPtr ppCoMemOutputWaveFormatEx);
    }

    [ComVisible(true), Guid("DE6988DD-75DB-43E9-9021-43C884474FEE"), ClassInterface(ClassInterfaceType.None)]
    public class Engine : ISpTTSEngine, ISpObjectWithToken
    {
        static readonly Guid WaveFormatEx = new Guid("C31ADBAE-527F-4ff5-A230-F62BB61FF70C");
        static int counter;
        IntPtr token = IntPtr.Zero;

        // Requests: "FAIC:<id>:<part>/<parts>:<base64>" ("AZIA" before the rename;
        // older engines let the game's "Start"/"End" bookmarks through).
        static readonly Regex Request = new Regex(
            @"^\s*(?:Start)?\s*(?:FAIC|AZIA):[^:\s]{1,64}:\d{1,4}/\d{1,4}:[A-Za-z0-9+/=\s]*$",
            RegexOptions.CultureInvariant);
        // The addon's voice test (/ia test-voice): "FAIC-VOICE-TEST ..." / "FAIC-VOICE-LONG ...".
        static readonly Regex VoiceTest = new Regex(
            @"^\s*FAIC-VOICE-(?:TEST|LONG) [A-Za-z0-9 ]*$",
            RegexOptions.CultureInvariant);
        const int MaxText = 200000; // the game cuts one phrase at ~30 000 characters

        static bool IsOurs(string text)
        {
            return text.Length <= MaxText && (Request.IsMatch(text) || VoiceTest.IsMatch(text));
        }

        static string DataDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ForeverAICompanion");
        }

        // A junction or symlink (or something that can't be checked).
        static bool IsLink(string path)
        {
            try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            catch { return true; }
        }

        // Creates `dir` when missing. null when it (or the data folder) is a link.
        static string SafeDir(string dir)
        {
            string data = DataDir();
            if (IsLink(data)) return null;
            if (dir != data && IsLink(dir)) return null;
            Directory.CreateDirectory(dir);
            if (IsLink(data) || IsLink(dir)) return null;
            return dir;
        }

        // Diagnostics: %APPDATA%\ForeverAICompanion\tts-engine.log (small, rotated).
        // Never the spoken text itself.
        static void Log(string msg)
        {
            try
            {
                string dir = SafeDir(DataDir());
                if (dir == null) return;
                string file = Path.Combine(dir, "tts-engine.log");
                if (IsLink(file)) return;
                if (File.Exists(file) && new FileInfo(file).Length > 200000) File.Delete(file);
                string proc = "?";
                try { proc = System.Diagnostics.Process.GetCurrentProcess().ProcessName; } catch { }
                File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + proc + "] " + msg + Environment.NewLine);
            }
            catch { }
        }

        public Engine()
        {
            Log("voz cargada (" + (IntPtr.Size * 8) + " bits)");
        }

        public int SetObjectToken(IntPtr pToken)
        {
            if (pToken != IntPtr.Zero) Marshal.AddRef(pToken);
            if (token != IntPtr.Zero) Marshal.Release(token);
            token = pToken;
            return 0;
        }

        public int GetObjectToken(out IntPtr ppToken)
        {
            ppToken = token;
            if (token != IntPtr.Zero) Marshal.AddRef(token);
            return 0;
        }

        // 16 kHz, 16-bit, mono PCM (we never write any audio anyway).
        public int GetOutputFormat(IntPtr pTargetFmtId, IntPtr pTargetWaveFormatEx, out Guid pOutputFormatId, out IntPtr ppCoMemOutputWaveFormatEx)
        {
            Log("formato de salida pedido");
            pOutputFormatId = WaveFormatEx;
            IntPtr wfx = Marshal.AllocCoTaskMem(18);
            Marshal.WriteInt16(wfx, 0, 1);        // wFormatTag = PCM
            Marshal.WriteInt16(wfx, 2, 1);        // nChannels
            Marshal.WriteInt32(wfx, 4, 16000);    // nSamplesPerSec
            Marshal.WriteInt32(wfx, 8, 32000);    // nAvgBytesPerSec
            Marshal.WriteInt16(wfx, 12, 2);       // nBlockAlign
            Marshal.WriteInt16(wfx, 14, 16);      // wBitsPerSample
            Marshal.WriteInt16(wfx, 16, 0);       // cbSize
            ppCoMemOutputWaveFormatEx = wfx;
            return 0;
        }

        // SPVTEXTFRAG { SPVTEXTFRAG* pNext; SPVSTATE State; LPCWSTR pTextStart; ULONG ulTextLen; ... }
        // SPVSTATE starts with SPVACTIONS eAction (right after pNext).
        static int TextOffset { get { return IntPtr.Size == 8 ? 80 : 56; } }
        static int ActionOffset { get { return IntPtr.Size; } }
        const int SPVA_Speak = 0, SPVA_SpellOut = 4;

        public int Speak(uint dwSpeakFlags, ref Guid rguidFormatId, IntPtr pWaveFormatEx, IntPtr pTextFragList, IntPtr pOutputSite)
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                IntPtr frag = pTextFragList;
                int guard = 0;
                while (frag != IntPtr.Zero && guard++ < 100000)
                {
                    // Only text meant to be spoken: the game also sends bookmarks
                    // ("Start", "End") as separate fragments, which are skipped.
                    int action = Marshal.ReadInt32(frag, ActionOffset);
                    IntPtr text = Marshal.ReadIntPtr(frag, TextOffset);
                    int len = Marshal.ReadInt32(frag, TextOffset + IntPtr.Size);
                    if ((action == SPVA_Speak || action == SPVA_SpellOut) && text != IntPtr.Zero && len > 0)
                        sb.Append(Marshal.PtrToStringUni(text, len));
                    frag = Marshal.ReadIntPtr(frag, 0);
                }
                string all = sb.ToString();
                // Someone else's text: not ours to keep, not even in the log.
                if (!IsOurs(all)) return 0;
                Log("mensaje recibido: " + all.Length + " caracteres");
                Deliver(all);
            }
            catch (Exception e)
            {
                // Never break the game's speech pipeline.
                Log("error en Speak: " + e.Message);
            }
            return 0;
        }

        static void Deliver(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            string dir = SafeDir(Path.Combine(DataDir(), "tts-inbox"));
            if (dir == null)
            {
                Log("carpeta de entrada rechazada (es un enlace)");
                return;
            }
            string name = DateTime.UtcNow.Ticks.ToString("D20") + "-" + Interlocked.Increment(ref counter).ToString("D6");
            string tmp = Path.Combine(dir, name + ".tmp");
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            File.Move(tmp, Path.Combine(dir, name + ".txt"));
        }
    }
}
