import { readFileSync, existsSync } from "fs"
import { join, resolve } from "path"
import { fileURLToPath } from "url"
import { log } from "../logger.js"

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..")
const CONFIG_PATH = join(ROOT, "config.json")

type Vec3 = [number, number, number]

interface Config {
  playerName: string
  port: string
  tickingArea: { from: Vec3; to: Vec3 }
  regionMaxSize: Vec3
}

const DEFAULT_TICKING_AREA = { from: [0, -64, 0] as Vec3, to: [15, 319, 15] as Vec3 }

function bail(msg: string): never {
  log.error(msg, { prefix: "Config" })
  process.exit(1)
}

function vec3(v: unknown, label: string): Vec3 {
  if (!Array.isArray(v) || v.length < 3) bail(`${label} 必须是 [x, y, z] 数组`)
  const o = v as unknown[]
  if (typeof o[0] !== "number" || typeof o[1] !== "number" || typeof o[2] !== "number") {
    bail(`${label} 必须包含三个数字`)
  }
  return [o[0], o[1], o[2]]
}

export function loadConfig(): Config {
  log.info("读取 " + CONFIG_PATH, { prefix: "Config" })

  if (!existsSync(CONFIG_PATH)) {
    bail("找不到 " + CONFIG_PATH + "，请创建 config.json")
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
  } catch {
    bail(CONFIG_PATH + " JSON 格式错误")
  }

  if (typeof raw !== "object" || raw === null) {
    bail(CONFIG_PATH + " 必须是一个对象")
  }

  const obj = raw as Record<string, unknown>

  const playerName = obj.playerName
  if (typeof playerName !== "string" || playerName.trim() === "") {
    bail("playerName 不能为空")
  }

  const port = obj.port
  if (port !== "auto") {
    if (typeof port !== "string") {
      bail('port 必须为 "auto" 或端口号字符串')
    }
    const n = parseInt(port)
    if (isNaN(n) || n < 1 || n > 65535) {
      bail('port "' + port + '" 不是有效端口号 (1-65535)')
    }
  }

  const taRaw = obj.tickingArea
  const tickingArea = taRaw !== undefined
    ? { from: vec3((taRaw as Record<string, unknown>).from, "tickingArea.from"), to: vec3((taRaw as Record<string, unknown>).to, "tickingArea.to") }
    : DEFAULT_TICKING_AREA

  const rawMax = obj.regionMaxSize
  const regionMaxSize = rawMax !== undefined ? vec3(rawMax, "regionMaxSize") : [50, 50, 50] as Vec3

  log.info("玩家: " + playerName.trim(), { prefix: "Config" })
  log.info("端口: " + port, { prefix: "Config" })
  log.info(`常加载: [${tickingArea.from.join(",")}]~[${tickingArea.to.join(",")}]`, { prefix: "Config" })
  log.info(`区域最大范围: ${regionMaxSize.join("×")}`, { prefix: "Config" })
  return { playerName: playerName.trim(), port, tickingArea, regionMaxSize }
}
