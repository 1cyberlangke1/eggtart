import { GameLoop } from "../core/game-loop.js"

export interface BlockQueryResult {
  block: string
  states: Record<string, string>
  calls: number
}

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

export async function getBlock(
  x: number, y: number, z: number
): Promise<string | null> {
  try {
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
  } catch {
    return null
  }
}

export async function getBlockStates(
  x: number, y: number, z: number, blockId: string
): Promise<{ states: Record<string, string>; calls: number }> {
  try {
    const gl = GameLoop.instance
    if (!gl?.blockStateMap || !gl.parser) return { states: {}, calls: 0 }

    const result: Record<string, string> = {}
    let calls = 0

    for (const [stateName, def] of Object.entries(gl.blockStateMap)) {
      if (!def.blocks.includes(blockId)) continue

      const candidates = expandValues(def.values)

      const firstVal = candidates[0]
      if (firstVal === undefined) continue

      calls++
      const qv = quoteValue(firstVal)
      const r = await gl.exec(
        `testforblock ${x} ${y} ${z} ${blockId} ["${stateName}"=${qv}]`
      )

      if (gl.parser.captureLine(r.statusMessage, "commands.blockstate.stateError") !== null) continue
      if (gl.parser.captureLine(r.statusMessage, "commands.blockstate.invalidState") !== null) continue

      if (r.statusCode === 0) {
        result[stateName] = firstVal
        continue
      }

      for (let i = 1; i < candidates.length; i++) {
        const v = candidates[i]
        if (v === undefined) continue
        calls++
        const qv2 = quoteValue(v)
        const r2 = await gl.exec(
          `testforblock ${x} ${y} ${z} ${blockId} ["${stateName}"=${qv2}]`
        )
        if (r2.statusCode === 0) {
          result[stateName] = v
          break
        }
      }
    }

    return { states: result, calls }
  } catch {
    return { states: {}, calls: 0 }
  }
}

export async function getBlockWithStates(
  x: number, y: number, z: number
): Promise<BlockQueryResult | null> {
  try {
    const block = await getBlock(x, y, z)
    if (!block) return null

    const { states, calls } = await getBlockStates(x, y, z, block)
    return { block, states, calls }
  } catch {
    return null
  }
}
