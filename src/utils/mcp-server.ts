import { resolve } from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { GameLoop } from "./core/game-loop.js"
import { log } from "./logger.js"
import { regionManager } from "./world/region.js"
import { scanRegion } from "./world/scanner.js"
import { runScript } from "./world/script-runner.js"

function notConnected(): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: "游戏未连接" }], isError: true }
}

export async function startMcpServer(): Promise<void> {
  const mcp = new McpServer({ name: "mcbe-eggtart", version: "1.0.0" })

  mcp.registerTool("mcbe_create_region_at", {
    title: "Create MCBE Region",
    description: "框选两个坐标点并创建区域",
    inputSchema: z.object({
      x1: z.number().describe("点1 X 坐标"),
      y1: z.number().describe("点1 Y 坐标"),
      z1: z.number().describe("点1 Z 坐标"),
      x2: z.number().describe("点2 X 坐标"),
      y2: z.number().describe("点2 Y 坐标"),
      z2: z.number().describe("点2 Z 坐标"),
      name: z.string().optional().describe("区域名称，缺省自动生成"),
    }),
  }, (args) => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    regionManager.setP1(args.x1, args.y1, args.z1)
    regionManager.setP2(args.x2, args.y2, args.z2)
    const r = regionManager.createRegion(args.name)
    if (r === null) return { content: [{ type: "text", text: "区域创建失败" }], isError: true }
    if (r === "too_large") return { content: [{ type: "text", text: `区域过大，上限 ${regionManager.regionMaxSize[0]}×${regionManager.regionMaxSize[1]}×${regionManager.regionMaxSize[2]}` }], isError: true }
    if (r === "max_regions") return { content: [{ type: "text", text: "最多 5 个区域" }], isError: true }
    return { content: [{ type: "text", text: `区域 ${r.name} 已创建 (${r.p1.join(",")} ~ ${r.p2.join(",")})` }] }
  })

  mcp.registerTool("mcbe_list_regions", {
    title: "List MCBE Regions",
    description: "列出 MCBE 游戏中所有已保存的区域",
    inputSchema: z.object({}),
  }, () => {
    const list = regionManager.listRegions()
    if (list.length === 0) return { content: [{ type: "text", text: "暂无已保存的区域" }] }
    const lines = list.map(r => `${r.name}: (${r.p1.join(",")}) ~ (${r.p2.join(",")})`)
    return { content: [{ type: "text", text: lines.join("\n") }] }
  })

  mcp.registerTool("mcbe_get_region", {
    title: "Get MCBE Region",
    description: "查询 MCBE 游戏中指定区域的坐标和大小",
    inputSchema: z.object({
      name: z.string().describe("区域名称"),
    }),
  }, (args) => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    const r = regionManager.regions.get(args.name)
    if (!r) return { content: [{ type: "text", text: `找不到区域 ${args.name}` }], isError: true }
    const [mx, Mx] = r.p1[0] < r.p2[0] ? [r.p1[0], r.p2[0]] : [r.p2[0], r.p1[0]]
    const [my, My] = r.p1[1] < r.p2[1] ? [r.p1[1], r.p2[1]] : [r.p2[1], r.p1[1]]
    const [mz, Mz] = r.p1[2] < r.p2[2] ? [r.p1[2], r.p2[2]] : [r.p2[2], r.p1[2]]
    const size = `${Mx - mx + 1}×${My - my + 1}×${Mz - mz + 1}`
    return { content: [{ type: "text", text: `${r.name}: (${r.p1.join(",")}) ~ (${r.p2.join(",")}) [${size}]` }] }
  })

  mcp.registerTool("mcbe_delete_region", {
    title: "Delete MCBE Region",
    description: "删除 MCBE 游戏中指定名称的区域",
    inputSchema: z.object({
      name: z.string().describe("要删除的区域名称"),
    }),
  }, (args) => {
    const gl = GameLoop.instance
    if (!gl?.connected) return notConnected()
    if (regionManager.deleteRegion(args.name)) {
      return { content: [{ type: "text", text: `区域 ${args.name} 已删除` }] }
    }
    return { content: [{ type: "text", text: `找不到区域 ${args.name}` }], isError: true }
  })

  mcp.registerTool("mcbe_scan_region", {
    title: "Scan MCBE Region",
    description: "重量级操作，仅用户明确要求扫描时调用，优先复用已有扫描文件。结果保存到本地文件。",
    inputSchema: z.object({
      name: z.string().describe("区域名称"),
      path: z.string().describe("保存路径，支持 ~ 开头，Windows 用 forward slash（如 C:/Users/xxx/Desktop）"),
      states: z.boolean().optional().default(true).describe("是否检测方块状态"),
      waterlog: z.boolean().optional().default(true).describe("是否检测含水"),
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
    description: "在游戏中执行一条 MCBE 命令并返回游戏输出的原始文本",
    inputSchema: z.object({
      command: z.string().describe("要执行的 Minecraft 命令，不需要前导斜杠"),
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
    description: "在指定区域内执行自定义脚本。脚本中用相对坐标（0,0,0=区域最小角）放置方块，提供 setBlock(rx,ry,rz,blockId,states?) 和 fillBlock(rx1,ry1,rz1,rx2,ry2,rz2,blockId,states?) 两个函数。支持循环、条件、变量。",
    inputSchema: z.object({
      name: z.string().describe("区域名称"),
      script: z.string().describe("JavaScript 脚本代码，支持 setBlock 和 fillBlock 两个全局函数"),
      timeout: z.number().optional().default(30).describe("超时秒数"),
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
