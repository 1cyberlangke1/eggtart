import { writeFileSync, mkdirSync } from "fs"
import { join, resolve } from "path"
import { fileURLToPath } from "url"
import { GameLoop } from "../core/game-loop.js"
import { type Region } from "./region.js"
import { waterlogBatch } from "./waterlog.js"

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..")
const STRUCT_DIR = join(ROOT, "struct")

export interface ScanOptions {
  name?: string | undefined
  states?: boolean | undefined
  waterlog?: boolean | undefined
}

export interface PaletteEntry {
  id: string
  states?: Record<string, string>
  waterlogged?: boolean
}

interface BlockEntry {
  x: number
  y: number
  z: number
  p: number
}

export interface ScanResult {
  name: string
  size: [number, number, number]
  scannedAt: string
  total: number
  palette: PaletteEntry[]
  blocks: BlockEntry[]
}

const MAX_CHAT = 500

function truncate(s: string): string {
  if (s.length <= MAX_CHAT) return s
  return s.slice(0, MAX_CHAT) + "..."
}

let scanning = false

function expandValues(raw: string): string[] {
  const m = raw.match(/^(\d+)-(\d+)$/)
  if (m) {
    const a = m[1]
    const b = m[2]
    if (a === undefined || b === undefined) return raw.split(",")
    const min = parseInt(a)
    const max = parseInt(b)
    return Array.from({ length: max - min + 1 }, (_, i) => String(min + i))
  }
  return raw.split(",")
}

function quoteValue(v: string): string {
  return /^\d+$|^true$|^false$/i.test(v) ? v : `"${v}"`
}

async function probeBlock(x: number, y: number, z: number): Promise<string | null> {
  const gl = GameLoop.instance
  if (!gl?.blocks || !gl.parser) return null
  const values = Object.values(gl.blocks)
  if (values.length === 0) return null
  const probeId = values[0]
  if (probeId === undefined) return null
  const r = await gl.exec(`testforblock ${x} ${y} ${z} ${probeId}`)
  if (r.statusCode === 0) return probeId
  const m = gl.parser.captureLine(r.statusMessage, "commands.testforblock.failed.tile")
  if (!m || m.length < 4) return null
  const name = m[3]
  if (name === undefined) return null
  return gl.blocks[name] ?? null
}

async function probeStates(x: number, y: number, z: number, blockId: string): Promise<Record<string, string>> {
  const gl = GameLoop.instance
  if (!gl?.blockStateMap || !gl.parser) return {}
  const result: Record<string, string> = {}
  for (const [stateName, def] of Object.entries(gl.blockStateMap)) {
    if (!def.blocks.includes(blockId)) continue
    const candidates = expandValues(def.values)
    const firstVal = candidates[0]
    if (firstVal === undefined) continue
    const qv = quoteValue(firstVal)
    const r = await gl.exec(`testforblock ${x} ${y} ${z} ${blockId} ["${stateName}"=${qv}]`)
    if (gl.parser.captureLine(r.statusMessage, "commands.blockstate.stateError") !== null) continue
    if (gl.parser.captureLine(r.statusMessage, "commands.blockstate.invalidState") !== null) continue
    if (r.statusCode === 0) {
      result[stateName] = firstVal
      continue
    }
    for (let i = 1; i < candidates.length; i++) {
      const v = candidates[i]
      if (v === undefined) continue
      const qv2 = quoteValue(v)
      const r2 = await gl.exec(`testforblock ${x} ${y} ${z} ${blockId} ["${stateName}"=${qv2}]`)
      if (r2.statusCode === 0) {
        result[stateName] = v
        break
      }
    }
  }
  return result
}

function progressBar(done: number, total: number): string {
  const pct = Math.round(done / total * 100)
  return `§a${pct}% §7| §f${done}/${total}`
}

async function runWithProgress<T>(
  items: T[],
  phase: string,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  const gl = GameLoop.instance
  let done = 0
  let lastTitle = 0
  const total = items.length
  gl?.fire(`title @a actionbar §6${phase} ${progressBar(0, total)}`)
  await Promise.all(items.map(async (item, i) => {
    if (item === undefined) return
    await fn(item, i)
    const now = Date.now()
    done++
    if (now - lastTitle >= 1000) {
      lastTitle = now
      gl?.fire(`title @a actionbar §6${phase} ${progressBar(done, total)}`)
    }
  }))
}

export async function scanRegion(
  region: Region,
  opts: ScanOptions = {},
): Promise<{ result: ScanResult; summary: string }> {
  if (scanning) throw new Error("已有扫描任务正在运行")
  scanning = true
  const startTime = Date.now()
  try {
    const gl = GameLoop.instance
    if (!gl) throw new Error("GameLoop not initialized")

    const name = opts.name ?? `scan_${Date.now()}`
    const doStates = opts.states ?? true
    const doWaterlog = opts.waterlog ?? true

    const [mx, Mx] = region.p1[0] < region.p2[0] ? [region.p1[0], region.p2[0]] : [region.p2[0], region.p1[0]]
    const [my, My] = region.p1[1] < region.p2[1] ? [region.p1[1], region.p2[1]] : [region.p2[1], region.p1[1]]
    const [mz, Mz] = region.p1[2] < region.p2[2] ? [region.p1[2], region.p2[2]] : [region.p2[2], region.p1[2]]

    const sizeX = Mx - mx + 1
    const sizeY = My - my + 1
    const sizeZ = Mz - mz + 1

    const positions: Array<[number, number, number]> = []
    for (let y = my; y <= My; y++)
      for (let z = mz; z <= Mz; z++)
        for (let x = mx; x <= Mx; x++)
          positions.push([x, y, z])

    // Phase 1: probe all block IDs
    const blockIds: Array<string | null | undefined> = []
    await runWithProgress(positions, "方块扫描", async (pos, i) => {
      blockIds[i] = await probeBlock(pos[0], pos[1], pos[2])
    })

    // Collect non-air positions for phases 2-3
    const nonAir: Array<{ idx: number; blockId: string; x: number; y: number; z: number }> = []
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]
      const blockId = blockIds[i]
      if (blockId !== undefined && blockId !== null && blockId !== "air" && pos) {
        nonAir.push({ idx: i, blockId, x: pos[0], y: pos[1], z: pos[2] })
      }
    }

    // Phase 2: states (if enabled)
    const stateResults: Array<Record<string, string> | undefined> = []
    if (doStates) {
      await runWithProgress(nonAir, "状态检测", async ({ idx, x, y, z, blockId }) => {
        const s = await probeStates(x, y, z, blockId)
        stateResults[idx] = Object.keys(s).length > 0 ? s : undefined
      })
    }

    // Phase 3: waterlog (if enabled)
    const waterResults: Array<boolean | undefined> = []
    if (doWaterlog && gl.waterloggableBlocks && gl.tickingReady) {
      const wlTargets = nonAir.filter(({ blockId }) => gl.waterloggableBlocks?.has(blockId))
      if (wlTargets.length > 0) {
        gl.fire(`title @a actionbar §6含水检测 §7| §f0/${wlTargets.length}`)
        const wlInput = wlTargets.map(p => [p.x, p.y, p.z] as [number, number, number])
        const wlOut = await waterlogBatch(wlInput)
        for (let k = 0; k < wlTargets.length; k++) {
          const entry = wlTargets[k]
          const v = wlOut[k]
          if (entry) waterResults[entry.idx] = v ?? undefined
        }
      }
    }

    // Build palette + blocks
    const paletteMap = new Map<string, number>()
    const palette: PaletteEntry[] = []
    const blocks: BlockEntry[] = []

    for (const { idx, blockId, x, y, z } of nonAir) {
      const states = stateResults[idx] ?? undefined
      const wl = waterResults[idx]

      const stateKey = states ? Object.entries(states).map(([k, v]) => `${k}=${v}`).sort().join(",") : ""
      const key = `${blockId}|${stateKey}|${wl ?? ""}`

      let pIdx = paletteMap.get(key)
      if (pIdx === undefined) {
        pIdx = palette.length
        paletteMap.set(key, pIdx)
        const entry: PaletteEntry = { id: blockId }
        if (states && Object.keys(states).length > 0) entry.states = states
        if (wl !== undefined) entry.waterlogged = wl
        palette.push(entry)
      }

      blocks.push({ x, y, z, p: pIdx })
    }

    const result: ScanResult = {
      name,
      size: [sizeX, sizeY, sizeZ],
      scannedAt: new Date().toISOString(),
      total: blocks.length,
      palette,
      blocks,
    }

    mkdirSync(STRUCT_DIR, { recursive: true })
    writeFileSync(join(STRUCT_DIR, `${name}.json`), JSON.stringify(result, null, 2))

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const summary = truncate(
      `扫描完成: ${result.total} 个非空气方块, ${palette.length} 种, 耗时 ${elapsed}s, 已保存到 struct/${name}.json`
    )

    return { result, summary }
  } finally {
    scanning = false
  }
}
