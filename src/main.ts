import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { Server, ServerEvent } from "socket-be"
import { GameLoop } from "./utils/core/game-loop.js"
import { log } from "./utils/logger.js"
import { loadConfig } from "./utils/config/config.js"
import { findFreePort, checkPortAvailable } from "./utils/config/port.js"
import { detectLanguage } from "./utils/lang/lang-detect.js"
import { registerChatCommands, cmd, str, optStr, optBool } from "./utils/chat/chat-handler.js"
import { coord, optCoord, resolveCoords } from "./utils/coord.js"
import { handleSetp1, handleSetp2, handleCreate, handleDelRegion, handleListRegions } from "./utils/chat/cmd-handlers.js"
import { getBlockWithStates } from "./utils/world/block-utils.js"
import { regionManager } from "./utils/world/region.js"
import { scanRegion } from "./utils/world/scanner.js"
import { tickingList, tickingEnsure, tickingFillChunk } from "./utils/world/ticking-area.js"
import { SwordTracker } from "./utils/world/sword-track.js"
import { RegionDeleter } from "./utils/world/region-deleter.js"
import { waterlogCheck, waterlogBatch } from "./utils/world/waterlog.js"
import { startMcpServer } from "./utils/mcp-server.js"
import { DATA_DIR } from "./utils/paths.js"

const config = loadConfig()
let port: number

if (config.port === "auto") {
  port = await findFreePort()
} else {
  port = parseInt(config.port)
  if (!(await checkPortAvailable(port))) {
    log.error(`端口 ${port} 已被占用`)
    process.exit(1)
  }
}

const server = new Server({ port })
const gl = new GameLoop(server, 100)
gl.playerName = config.playerName
const swordTracker = new SwordTracker()
const regionDeleter = new RegionDeleter()

startMcpServer(port).catch((e: unknown) => {
  log.error("MCP 服务器启动失败: " + (e as Error).message)
})

server.on(ServerEvent.ItemInteracted, (ev) => {
  swordTracker.onItemInteracted(ev)
  regionDeleter.onItemInteracted(ev)
})

registerChatCommands(server, [
  cmd("waterlog", [coord("x"), coord("y"), coord("z")], async (x, y, z) => {
    const [px, py, pz] = await resolveCoords(x, y, z)
    const r = await waterlogCheck(px, py, pz)
    if (r === null) return "检测失败"
    return r ? `${px} ${py} ${pz} → 含水` : `${px} ${py} ${pz} → 不含水`
  }, "检测单个方块是否含水"),
  cmd("scanWaterlog", [coord("x1"), coord("y1"), coord("z1"), coord("x2"), coord("y2"), coord("z2")], async (x1, y1, z1, x2, y2, z2) => {
    const [px1, py1, pz1] = await resolveCoords(x1, y1, z1)
    const [px2, py2, pz2] = await resolveCoords(x2, y2, z2)
    const positions: Array<[number, number, number]> = []
    const [mx, Mx] = [Math.min(px1, px2), Math.max(px1, px2)]
    const [my, My] = [Math.min(py1, py2), Math.max(py1, py2)]
    const [mz, Mz] = [Math.min(pz1, pz2), Math.max(pz1, pz2)]
    for (let y = my; y <= My; y++)
      for (let z = mz; z <= Mz; z++)
        for (let x = mx; x <= Mx; x++)
          positions.push([x, y, z])
    const results = await waterlogBatch(positions)
    return results.map((r, i) => {
      const pos = positions[i]
      if (!pos) return ""
      return `${pos[0]} ${pos[1]} ${pos[2]} → ${r ? "含水" : "不含水"}`
    }).join("\n")
  }, "批量扫描矩形区域含水"),
  cmd("getBlock", [coord("x"), coord("y"), coord("z")], async (x, y, z) => {
    const [px, py, pz] = await resolveCoords(x, y, z)
    const r = await getBlockWithStates(px, py, pz)
    if (!r) return null
    const s = Object.entries(r.states).map(([kv, vv]) => `${kv}=${vv}`).join(", ")
    return `${px} ${py} ${pz} → ${r.block} [${s}] (${r.calls}次)`
  }, "查询方块 ID 和状态"),
  cmd("setp1", [optCoord("x"), optCoord("y"), optCoord("z")], async (x, y, z) => {
    const [px, py, pz] = await resolveCoords(x, y, z)
    if (px === undefined || py === undefined || pz === undefined) return "无法解析坐标"
    return handleSetp1(px, py, pz)
  }, "选择点1（缺省用当前位置）"),
  cmd("setp2", [optCoord("x"), optCoord("y"), optCoord("z")], async (x, y, z) => {
    const [px, py, pz] = await resolveCoords(x, y, z)
    if (px === undefined || py === undefined || pz === undefined) return "无法解析坐标"
    return handleSetp2(px, py, pz)
  }, "选择点2（缺省用当前位置）"),
  cmd("create", [optStr("name")], (name) => handleCreate(name), "创建区域（缺省名自动生成）"),
  cmd("regions", [], () => Promise.resolve(handleListRegions()), "列出所有区域"),
  cmd("delRegion", [str("name")], (name) => handleDelRegion(name), "删除指定区域"),
  cmd("sword", [optBool("enabled")], (enabled?) => {
    const v = enabled !== undefined ? enabled : !swordTracker.enabled
    swordTracker.setEnabled(v)
    return Promise.resolve(v ? "剑追踪已开启" : "剑追踪已关闭")
  }, "剑追踪开关（默认开启）"),
  cmd("scanRegion", [str("name"), optBool("states"), optBool("waterlog"), optBool("normalize")], async (name, states?, waterlog?, normalize?) => {
    const region = regionManager.regions.get(name)
    if (!region) return "找不到区域 " + name
    try {
      const { summary } = await scanRegion(region, { name, states, waterlog, normalize })
      return summary
    } catch (e: unknown) {
      return `扫描失败: ${(e as Error).message}`
    }
  }, "扫描区域方块信息并保存到文件[normalize: 坐标归零]"),
])

server.on(ServerEvent.Open, () => {
  log.info(`WS 服务器启动于 ws://localhost:${port}`)
})

server.on(ServerEvent.WorldInitialize, async () => {
  log.success("§aEggTart 已就绪! §r!help 查看命令, 右键剑选点", { game: true })

  const r = await gl.exec("help")
  const d = detectLanguage(r.statusMessage)
  if (!d) {
    console.error(r.statusMessage)
    log.error("语言检测失败")
    process.exit(1)
  }

  gl.parser = d.parser
  gl.lang = d.lang

  const blocksPath = join(DATA_DIR, d.lang, "blocks.json")
  if (existsSync(blocksPath)) {
    gl.blocks = JSON.parse(readFileSync(blocksPath, "utf-8")) as Record<string, string>
    log.info(`已加载 ${Object.keys(gl.blocks).length} 个方块名 (${blocksPath})`, { color: "gray" })
  }

  const statePath = join(DATA_DIR, "block_state_map.json")
  if (existsSync(statePath)) {
    gl.blockStateMap = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, { blocks: string[]; values: string }>
    log.info(`已加载方块状态表 (${statePath})`, { color: "gray" })
  }

  log.info("语言: " + d.lang, { color: "gray" })

  const ta = config.tickingArea
  const st = await tickingList()
  if (!st) {
    log.error("常加载列表获取失败", { prefix: "Ticking" })
  } else if (st.full && !st.areas.some(a => a.name === "eggtart_ws")) {
    log.warn(`常加载已满 (${st.cur}/${st.max})，不可用`, { prefix: "Ticking" })
  } else {
    if (!st.areas.some(a => a.name === "eggtart_ws")) {
      const r = await tickingEnsure("eggtart_ws", ta.from, ta.to)
      if (!r.ok) {
        log.error("常加载区块创建失败", { prefix: "Ticking" })
      }
    }
    tickingFillChunk(0, 0, ta.from[1], ta.to[1])
    gl.tickingReady = true
    log.info(`常加载就绪 [${ta.from.join(",")}]~[${ta.to.join(",")}] (${st.cur}/${st.max})`, { prefix: "Ticking" })
  }
  const wlPath = join(DATA_DIR, "waterloggable_blocks.json")
  if (existsSync(wlPath)) {
    gl.waterloggableBlocks = new Set(JSON.parse(readFileSync(wlPath, "utf-8")) as string[])
    log.info(`已加载 ${gl.waterloggableBlocks.size} 个含水方块`, { color: "gray" })
  }

  regionManager.regionMaxSize = config.regionMaxSize
  regionManager.tickingAreaFrom = ta.from
  regionManager.tickingAreaTo = ta.to
  regionManager.createLanes()
  log.info(`区域最大范围: ${config.regionMaxSize.join("×")}`, { color: "gray" })

  swordTracker.startTimers()
  log.info("剑追踪已开启 — 右键下界合金剑选点", { color: "gray" })
  regionDeleter.startTimers()
  log.info("木剑删除已开启 — 右键木剑删除区域", { color: "gray" })
})

server.on(ServerEvent.Close, () => {
  swordTracker.stop()
  regionDeleter.stop()
  log.info("WS 服务器关闭")
})

export { gl as gameLoop }
