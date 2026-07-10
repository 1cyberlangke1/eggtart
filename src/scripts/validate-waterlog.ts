import { writeFileSync, existsSync, readdirSync, mkdirSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { fileURLToPath } from "url"
import { Server, ServerEvent } from "socket-be"
import { createServer } from "net"

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url))
const ROOT = resolve(SCRIPT_DIR, "..")
const DATA_DIR = join(ROOT, "data")

function parsePort(): number {
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

function findFreePort(): Promise<number> {
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

const BOOTHS: [number, number, number][] = (() => {
  const r: [number, number, number][] = []
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
    r.push([x * 4, 0, z * 4])
    r.push([x * 4, 4, z * 4])
  }
  return r
})()

function detectLanguage(helpMsg: string): string | null {
  if (!existsSync(DATA_DIR)) return null
  for (const langDir of readdirSync(DATA_DIR)) {
    const cp = join(DATA_DIR, langDir, "commands.json")
    if (!existsSync(cp)) continue
    try {
      const c = JSON.parse(readFileSync(cp, "utf-8")) as Record<string, string>
      const footer = c["commands.help.footer"]
      if (footer && helpMsg.includes(footer)) {
        return langDir
      }
    } catch { /* skip */ }
  }
  return null
}

async function main() {
  const port = parsePort()
  const actualPort = port === 0 ? await findFreePort() : port

  await new Promise<void>((resolveMain) => {
    let server: Server
    try {
      server = new Server({ port: actualPort })
    } catch (e: unknown) {
      console.error(`[错误] 无法监听端口 ${actualPort}: ${(e as Error).message}`)
      resolveMain()
      return
    }

    server.on(ServerEvent.Open, () => {
      console.log(`\nsocket-be 监听端口: ${actualPort}`)
      console.log(`等待 MC 连接 ws://localhost:${actualPort} ...`)
    })

    server.on(ServerEvent.WorldInitialize, async (ev) => {
      try {
        const world = ev.world

        console.log("\n查询方块数据...")
        const raw = await world.queryData("block") as Array<{ name: string; id: string }>
        const allIds = [...new Set(raw.map(b => b.id))].sort()
        console.log(`[queryData] ${allIds.length} 个方块`)

        console.log("\n检测游戏语言...")
        let activeLang = "en_US"
        try {
          const helpR = await world.runCommand("help")
          const msg: string = helpR.statusMessage
          const detected = detectLanguage(msg)
          if (detected) activeLang = detected
        } catch { /* use default */ }
        console.log(`[语言] ${activeLang}`)

        const waterloggable: string[] = []
        let totalTests = 0
        let lastTitle = 0

        async function runBooth(pos: [number, number, number], ids: string[]) {
          const [bx, by, bz] = pos

          for (const blockId of ids) {
            await world.runCommand(`setblock ${bx} ${by - 1} ${bz} glass replace`)
            await world.runCommand(`setblock ${bx} ${by + 1} ${bz} glass replace`)
            for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
              await world.runCommand(`setblock ${bx + dx} ${by} ${bz + dz} glass replace`)
            }

            await world.runCommand(`setblock ${bx} ${by} ${bz} air replace`)

            await world.runCommand(`setblock ${bx} ${by} ${bz} water`)
            const sr = await world.runCommand(`setblock ${bx} ${by} ${bz} ${blockId}`)
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
            if (sr.statusCode !== 0) {
              await world.runCommand(`setblock ${bx} ${by} ${bz} air replace`)
              continue
            }

            totalTests++
            await world.runCommand(`setblock ${bx} ${by - 1} ${bz} sponge`)
            const wr = await world.runCommand(`testforblock ${bx} ${by - 1} ${bz} wet_sponge`)
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
            if (wr.statusCode === 0) {
              waterloggable.push(blockId)
            }

            await world.runCommand(`setblock ${bx} ${by} ${bz} air replace`)
            await world.runCommand(`setblock ${bx} ${by - 1} ${bz} air replace`)

            const now = Date.now()
            if (now - lastTitle >= 1000) {
              lastTitle = now
              const pct = Math.round(totalTests / allIds.length * 100)
              console.log(`[进度] ${totalTests}/${allIds.length} (${pct}%) | ${waterloggable.length} 含水方块`)
              await world.runCommand(
                `title @a actionbar §6验证 §a${pct}% §7| §f${totalTests}/${allIds.length}`
              )
            }
          }
        }

        const chunkSize = Math.ceil(allIds.length / BOOTHS.length)
        const chunks: Array<{ pos: [number, number, number]; ids: string[] }> = BOOTHS.map((b, i) => ({
          pos: b,
          ids: allIds.slice(i * chunkSize, (i + 1) * chunkSize),
        }))

        await Promise.all(chunks.map(c => runBooth(c.pos, c.ids)))

        for (const pos of BOOTHS) {
          const [bx, by, bz] = pos
          await world.runCommand(`setblock ${bx} ${by} ${bz} air replace`)
          for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
            await world.runCommand(`setblock ${bx + dx} ${by} ${bz + dz} air replace`)
          }
          await world.runCommand(`setblock ${bx} ${by - 1} ${bz} air replace`)
          await world.runCommand(`setblock ${bx} ${by + 1} ${bz} air replace`)
        }

        const outPath = join(DATA_DIR, "waterloggable_blocks.json")
        mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(outPath, JSON.stringify(waterloggable, null, 2))

        console.log(`\n[完成] 总方块: ${allIds.length}`)
        console.log(`[完成] 含水: ${waterloggable.length}`)
        console.log(`[完成] ${outPath}`)
        process.exit(0)
      } catch (e: unknown) {
        console.error(`[错误] WorldInitialize 处理失败: ${(e as Error).message}`)
        process.exit(1)
      }
    })
  })
}

void main()
