/**
 * 端口探测模块
 *
 * 从首选端口开始，通过尝试 TCP 绑定方式探测可用端口。
 * 使用 net.createServer().listen() 而非 EADDRINUSE 解析，兼容性更好。
 */
import * as net from 'net'

/**
 * 探测从 preferredPort 开始的第一个可用 TCP 端口。
 *
 * @param preferredPort 首选端口，默认 12323
 * @param maxTries 最大尝试次数，默认 100
 * @returns 可用端口号
 * @throws 若超过 maxTries 均被占用，reject 含 'No available port found' 的错误
 */
export function findAvailablePort(
  preferredPort: number = 12323,
  maxTries: number = 100
): Promise<number> {
  return new Promise((resolve, reject) => {
    let tried = 0

    function tryPort(port: number): void {
      if (tried >= maxTries) {
        reject(
          new Error(
            `No available port found after ${maxTries} attempts starting from port ${preferredPort}`
          )
        )
        return
      }
      tried++

      const server = net.createServer()

      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close()
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          // 端口被占用或无权限，尝试下一个
          tryPort(port + 1)
        } else {
          reject(err)
        }
      })

      server.once('listening', () => {
        // 找到可用端口，立即关闭占位服务器
        server.close(() => resolve(port))
      })

      server.listen(port, '127.0.0.1')
    }

    tryPort(preferredPort)
  })
}
