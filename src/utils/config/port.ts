import { createServer } from "net"

export function parsePort(): number {
  const idx = process.argv.indexOf("--port")
  if (idx >= 0) {
    const arg = process.argv[idx + 1]
    if (arg) {
      const v = parseInt(arg)
      if (!isNaN(v)) return v
    }
  }
  return 8000
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const addr = srv.address()
      if (addr && typeof addr === "object" && "port" in addr) {
        srv.close(() => { resolve(addr.port) })
      } else {
        srv.close()
        reject(new Error("无法获取空闲端口"))
      }
    })
    srv.on("error", reject)
  })
}
