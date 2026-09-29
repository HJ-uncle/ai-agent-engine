import { execFile } from 'node:child_process'

/**
 * 把单个文件/目录移入操作系统回收站（不永久删除）。
 *
 * 为什么不引 npm 包：引擎是独立 Node 进程，没有 Electron 的 shell.trashItem；
 * 直接用系统自带命令实现，避免新增依赖。
 *
 * 失败时抛错，由调用方决定是否降级（本工具选择：回收站失败就直接失败，
 * 不静默退化成永久删除——避免「以为能找回，实际删没了」的误导）。
 */
export async function moveToSystemTrash(targetPath: string): Promise<void> {
  switch (process.platform) {
    case 'win32':
      await trashWindows(targetPath)
      return
    case 'darwin':
      await trashMac(targetPath)
      return
    default:
      await trashLinux(targetPath)
  }
}

// Windows：PowerShell + VisualBasic.FileIO.FileSystem（唯一原生「进回收站」的 API）。
// Remove-Item 是永久删除，不能用。FileSystem.DeleteFile/DeleteDirectory 的
// RecycleOption.SendToRecycleBin 会把路径进回收站。
function trashWindows(targetPath: string): Promise<void> {
  // 单引号字符串转义：路径里的 ' 换成 ''（PowerShell 转义规则）
  const escaped = targetPath.replace(/'/g, "''")
  const script = [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    "$fs = [Microsoft.VisualBasic.FileIO.FileSystem]",
    // 目录与文件走不同 API；先按是否存在判断
    `if (Test-Path -LiteralPath '${escaped}' -PathType Container) {`,
    `  $fs::DeleteDirectory('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    `} else {`,
    `  $fs::DeleteFile('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    `}`
  ].join('\n')
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
}

// macOS：Finder 的 delete 语义就是进回收站（POSIX path of 把路径转 HFS 风格）
function trashMac(targetPath: string): Promise<void> {
  const script = `tell application "Finder" to delete POSIX file "${targetPath.replace(/"/g, '\\"')}"`
  return run('osascript', ['-e', script])
}

// Linux：优先 gio trash（GNOME/通用），没有则退回 gvfs-trash（老系统）。
async function trashLinux(targetPath: string): Promise<void> {
  try {
    await run('gio', ['trash', targetPath])
  } catch (err) {
    // gio 不存在（命令找不到）时尝试 gvfs-trash；其它错误（权限等）直接上抛
    if (err instanceof Error && /ENOENT|not found/i.test(err.message)) {
      await run('gvfs-trash', [targetPath])
      return
    }
    throw err
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message))
        return
      }
      resolve()
    })
  })
}
