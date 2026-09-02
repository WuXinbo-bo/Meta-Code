using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace ClaudeCodexWorkbench.FolderPicker
{
    [Flags]
    internal enum FileOpenOptions : uint
    {
        PickFolders = 0x00000020,
        ForceFileSystem = 0x00000040,
        PathMustExist = 0x00000800,
        DontAddToRecent = 0x02000000
    }

    internal enum ShellItemDisplayName : uint
    {
        FileSystemPath = 0x80058000
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    internal class FileOpenDialog
    {
    }

    [ComImport]
    [Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(FileOpenOptions options);
        void GetOptions(out FileOpenOptions options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int alignment);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int errorCode);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid interfaceId, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(ShellItemDisplayName displayName, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    internal static class NativeMethods
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        internal static extern void SHCreateItemFromParsingName(
            string path,
            IntPtr bindContext,
            ref Guid interfaceId,
            out IShellItem shellItem);
    }

    internal static class Program
    {
        private const int Cancelled = unchecked((int)0x800704C7);

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                if (HasArgument(args, "--version"))
                {
                    WriteOutput("FolderPicker 1");
                    return 0;
                }

                string selectedPath = SelectFolder(
                    OptionValue(args, "--initial-path"),
                    OptionValue(args, "--title") ?? "选择文件夹"
                );
                if (!String.IsNullOrEmpty(selectedPath)) WriteOutput(selectedPath);
                return 0;
            }
            catch (Exception error)
            {
                WriteError(error.ToString());
                return 1;
            }
        }

        private static void WriteOutput(string value)
        {
            WriteUtf8(Console.OpenStandardOutput(), value);
        }

        private static void WriteError(string value)
        {
            WriteUtf8(Console.OpenStandardError(), value);
        }

        private static void WriteUtf8(Stream stream, string value)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(value);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        private static string SelectFolder(string initialPath, string title)
        {
            IFileDialog dialog = null;
            IShellItem initialFolder = null;
            IShellItem result = null;
            try
            {
                dialog = (IFileDialog)new FileOpenDialog();
                dialog.SetOptions(
                    FileOpenOptions.PickFolders |
                    FileOpenOptions.ForceFileSystem |
                    FileOpenOptions.PathMustExist |
                    FileOpenOptions.DontAddToRecent
                );
                dialog.SetTitle(title);
                dialog.SetOkButtonLabel("选择文件夹");

                if (!String.IsNullOrWhiteSpace(initialPath) && Directory.Exists(initialPath))
                {
                    Guid shellItemId = typeof(IShellItem).GUID;
                    NativeMethods.SHCreateItemFromParsingName(
                        initialPath,
                        IntPtr.Zero,
                        ref shellItemId,
                        out initialFolder
                    );
                    dialog.SetFolder(initialFolder);
                }

                int status = dialog.Show(IntPtr.Zero);
                if (status == Cancelled) return null;
                if (status != 0) Marshal.ThrowExceptionForHR(status);

                dialog.GetResult(out result);
                IntPtr pathPointer;
                result.GetDisplayName(ShellItemDisplayName.FileSystemPath, out pathPointer);
                try
                {
                    return Marshal.PtrToStringUni(pathPointer);
                }
                finally
                {
                    Marshal.FreeCoTaskMem(pathPointer);
                }
            }
            finally
            {
                if (result != null) Marshal.ReleaseComObject(result);
                if (initialFolder != null) Marshal.ReleaseComObject(initialFolder);
                if (dialog != null) Marshal.ReleaseComObject(dialog);
            }
        }

        private static bool HasArgument(string[] args, string name)
        {
            foreach (string argument in args)
            {
                if (String.Equals(argument, name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static string OptionValue(string[] args, string name)
        {
            for (int index = 0; index < args.Length - 1; index += 1)
            {
                if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
            }
            return null;
        }
    }
}
