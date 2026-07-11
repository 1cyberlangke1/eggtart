import { resolve } from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { GameLoop } from "./core/game-loop.js"
import { log } from "./logger.js"
import { regionManager } from "./world/region.js"
import { scanRegion } from "./world/scanner.js"
import { runScript } from "./world/script-runner.js"

type RegionInfo = { name: string; p1: [number, number, number]; p2: [number, number, number] }

let mcpPort = 0

function notConnected(): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const hint = mcpPort ? `请在游戏中执行 /wsserver localhost:${mcpPort} 连接后重试` : "请先连接游戏后重试"
  return { content: [{ type: "text", text: `游戏未连接。${hint}` }], isError: true }
}

function regionSize(r: RegionInfo): string {
  const [mx, Mx] = r.p1[0] < r.p2[0] ? [r.p1[0], r.p2[0]] : [r.p2[0], r.p1[0]]
  const [my, My] = r.p1[1] < r.p2[1] ? [r.p1[1], r.p2[1]] : [r.p2[1], r.p1[1]]
  const [mz, Mz] = r.p1[2] < r.p2[2] ? [r.p1[2], r.p2[2]] : [r.p2[2], r.p1[2]]
  const w = Mx - mx + 1
  const h = My - my + 1
  const d = Mz - mz + 1
  return `${w}×${h}×${d}, ${w * h * d} blocks`
}

function dirFromYaw(yRot: number): string {
  const deg = ((yRot % 360) + 360) % 360
  const dirs = ["南", "西南", "西", "西北", "北", "东北", "东", "东南"]
  return dirs[Math.round(deg / 45) % 8] as string
}

export async function startMcpServer(port: number = 0): Promise<void> {
  mcpPort = port
  const mcp = new McpServer({ name: "mcbe-eggtart", version: "1.0.0" })

  mcp.registerTool("mcbe_create_region_at", {
    title: "Create MCBE Region",
    description: "Create a cuboid region from two corner coordinates",
    inputSchema: z.object({
      x1: z.number().describe("Corner 1 X"),
      y1: z.number().describe("Corner 1 Y"),
      z1: z.number().describe("Corner 1 Z"),
      x2: z.number().describe("Corner 2 X"),
      y2: z.number().describe("Corner 2 Y"),
      z2: z.number().describe("Corner 2 Z"),
      name: z.string().optional().describe("Region name, auto-generated if omitted"),
    }),
  }, (args) => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    if (!regionManager.setP1(args.x1, args.y1, args.z1)) {
      return { content: [{ type: "text", text: "点1 在常加载区块内，请选其他位置" }], isError: true }
    }
    if (!regionManager.setP2(args.x2, args.y2, args.z2)) {
      return { content: [{ type: "text", text: "点2 在常加载区块内，请选其他位置" }], isError: true }
    }
    const r = regionManager.createRegion(args.name)
    if (r === null) return { content: [{ type: "text", text: "区域创建失败" }], isError: true }
    if (r === "too_large") return { content: [{ type: "text", text: `区域过大，上限 ${regionManager.regionMaxSize[0]}×${regionManager.regionMaxSize[1]}×${regionManager.regionMaxSize[2]}` }], isError: true }
    if (r === "max_regions") return { content: [{ type: "text", text: "最多 5 个区域" }], isError: true }
    return { content: [{ type: "text", text: `区域 ${r.name} 已创建 (${r.p1.join(",")} ~ ${r.p2.join(",")})` }] }
  })

  mcp.registerTool("mcbe_list_regions", {
    title: "List MCBE Regions",
    description: "List all saved regions with positions and sizes",
    inputSchema: z.object({}),
  }, () => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    const list = regionManager.listRegions()
    if (list.length === 0) return { content: [{ type: "text", text: "暂无已保存的区域" }] }
    const lines = list.map(r => `${r.name}: (${r.p1.join(",")}) ~ (${r.p2.join(",")}) [${regionSize(r)}]`)
    return { content: [{ type: "text", text: lines.join("\n") }] }
  })

  mcp.registerTool("mcbe_get_region", {
    title: "Get MCBE Region",
    description: "Get region details: coordinates, dimensions, and volume",
    inputSchema: z.object({
      name: z.string().describe("Region name"),
    }),
  }, (args) => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    const r = regionManager.regions.get(args.name)
    if (!r) return { content: [{ type: "text", text: `找不到区域 ${args.name}` }], isError: true }
    return { content: [{ type: "text", text: `${r.name}: (${r.p1.join(",")}) ~ (${r.p2.join(",")}) [${regionSize(r)}]` }] }
  })

  mcp.registerTool("mcbe_delete_region", {
    title: "Delete MCBE Region",
    description: "Delete a region by name",
    inputSchema: z.object({
      name: z.string().describe("Region name to delete"),
    }),
  }, (args) => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    if (regionManager.deleteRegion(args.name)) {
      return { content: [{ type: "text", text: `区域 ${args.name} 已删除` }] }
    }
    return { content: [{ type: "text", text: `找不到区域 ${args.name}` }], isError: true }
  })

  mcp.registerTool("mcbe_get_player_info", {
    title: "Get Player Info",
    description: "Get player position, facing direction, and dimension",
    inputSchema: z.object({}),
  }, async () => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    try {
      const r = await gl.exec(`querytarget @a[name=${gl.playerName},c=1]`)
      const raw = r.statusMessage
      const s = raw.indexOf("[")
      const e = raw.lastIndexOf("]")
      if (s < 0 || e < 0) return { content: [{ type: "text", text: "无法解析玩家数据" }], isError: true }
      const arr = JSON.parse(raw.slice(s, e + 1)) as Array<{ position: { x: number; y: number; z: number }; dimension: number; yRot: number }>
      if (!Array.isArray(arr) || arr.length === 0) return { content: [{ type: "text", text: "找不到玩家" }], isError: true }
      const first = arr[0] as { position: { x: number; y: number; z: number }; dimension: number; yRot: number }
      const p = first.position
      const dimNames = ["overworld", "nether", "the end"]
      const dim = dimNames[first.dimension] ?? `dim ${first.dimension}`
      const dir = dirFromYaw(first.yRot)
      const lines = [`${gl.playerName} @ ${dim}`, `位置: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`, `朝向: ${dir} (yaw: ${first.yRot.toFixed(1)})`]
      return { content: [{ type: "text", text: lines.join("\n") }] }
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `查询失败: ${(e as Error).message}` }], isError: true }
    }
  })

  mcp.registerTool("mcbe_scan_region", {
    title: "Scan MCBE Region",
    description: "Heavy operation: scan every block in a region and save results to a JSON file. Only call when user explicitly requests scanning. Reuses existing scan files when possible.",
    inputSchema: z.object({
      name: z.string().describe("Region name to scan"),
      path: z.string().describe("Output directory (supports ~ for home, use forward slashes, e.g. C:/Users/xxx/Desktop)"),
      states: z.boolean().optional().default(true).describe("Detect block states"),
      waterlog: z.boolean().optional().default(true).describe("Detect waterlogged blocks"),
    }),
  }, async (args) => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    const region = regionManager.regions.get(args.name)
    if (!region) return { content: [{ type: "text", text: `找不到区域 ${args.name}` }], isError: true }
    const resolvedPath = resolve(args.path.replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? ""))
    try {
      const { summary } = await scanRegion(region, { name: region.name, states: args.states, waterlog: args.waterlog, outputDir: resolvedPath })
      return { content: [{ type: "text", text: summary }] }
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `扫描失败: ${(e as Error).message}` }], isError: true }
    }
  })

  mcp.registerTool("mcbe_run_command", {
    title: "Run MCBE Command",
    description: "Execute any Minecraft command and return raw output as seen in-game",
    inputSchema: z.object({
      command: z.string().describe("Minecraft command without leading slash"),
    }),
  }, async (args) => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    try {
      const r = await gl.exec(args.command)
      return { content: [{ type: "text", text: r.statusMessage }] }
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `命令执行失败: ${(e as Error).message}` }], isError: true }
    }
  })

  mcp.registerTool("mcbe_run_script", {
    title: "Run MCBE Script",
    description: "Execute a JS script inside a region. Coordinates are relative (0,0,0 = region min corner). Provides setBlock(rx,ry,rz,blockId,states?) and fillBlock(rx1,ry1,rz1,rx2,ry2,rz2,blockId,states?). Supports loops, conditionals, variables.",
    inputSchema: z.object({
      name: z.string().describe("Target region name"),
      script: z.string().describe("JavaScript code using setBlock() and fillBlock() globals"),
      timeout: z.number().optional().default(30).describe("Timeout in seconds"),
    }),
  }, (args) => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    const region = regionManager.regions.get(args.name)
    if (!region) return { content: [{ type: "text", text: `找不到区域 ${args.name}` }], isError: true }
    try {
      const r = runScript(region, args.script, args.timeout)
      const parts: string[] = [`脚本执行完成: 共 ${r.total} 个方块操作`]
      if (r.timedOut) parts.push("（脚本执行超时）")
      return { content: [{ type: "text", text: parts.join(" ") }] }
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `脚本错误: ${(e as Error).message}` }], isError: true }
    }
  })

  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  log.info("MCP 服务器已启动 (stdio)")
}
