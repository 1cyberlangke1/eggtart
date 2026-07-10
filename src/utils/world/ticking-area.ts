import { GameLoop } from "../core/game-loop.js"

export interface TickingArea {
  name: string
  from: [number, number, number]
  to: [number, number, number]
  preload: boolean
}

export interface TickingState {
  areas: TickingArea[]
  cur: number
  max: number
  full: boolean
}

function escRe(s: string): string {
  return s.replace(/[.+*?^${}()|[\]\\]/g, "\\$&")
}

function buildRowPattern(): RegExp {
  const gl = GameLoop.instance
  const to = gl?.parser?.getRaw("commands.tickingarea-list.to") ?? "to"
  const escTo = escRe(to)
  return new RegExp(`^- (.+?): (-?\\d+) (-?\\d+) (-?\\d+) ${escTo} (-?\\d+) (-?\\d+) (-?\\d+)(?: (.+))?$`)
}

export async function tickingList(): Promise<TickingState | null> {
  try {
    const gl = GameLoop.instance
    if (!gl?.parser) return null

    const r = await gl.exec("tickingarea list")
    const msg = r.statusMessage

    if (gl.parser.captureLine(msg, "commands.tickingarea.noneExist.currentDimension") !== null) {
      return { areas: [], cur: 0, max: 10, full: false }
    }

    const inuse = gl.parser.captureLine(msg, "commands.tickingarea.inuse")
    if (!inuse || inuse.length < 2) return null
    const curRaw = inuse[0]
    const maxRaw = inuse[1]
    if (curRaw === undefined || maxRaw === undefined) return null
    const cur = parseInt(curRaw)
    const max = parseInt(maxRaw)

    const rowRe = buildRowPattern()
    const preloadText = gl.parser.getRaw("commands.tickingarea-list.preload") ?? ""
    const rows: TickingArea[] = []

    for (const raw of msg.split("\n")) {
      const line = raw.replace(/§./g, "").trim()
      if (!line) continue
      const m = line.match(rowRe)
      if (!m) continue
      const name = m[1]
      const x1 = m[2]; const y1 = m[3]; const z1 = m[4]
      const x2 = m[5]; const y2 = m[6]; const z2 = m[7]
      if (!name || x1 === undefined || y1 === undefined || z1 === undefined ||
          x2 === undefined || y2 === undefined || z2 === undefined) continue
      rows.push({
        name,
        from: [parseInt(x1), parseInt(y1), parseInt(z1)],
        to: [parseInt(x2), parseInt(y2), parseInt(z2)],
        preload: preloadText ? (m[8]?.includes(preloadText) ?? false) : false,
      })
    }

    return { areas: rows, cur, max, full: cur >= max }
  } catch {
    return null
  }
}

export async function tickingEnsure(
  name: string,
  from: [number, number, number],
  to: [number, number, number]
): Promise<{ ok: boolean }> {
  try {
    const gl = GameLoop.instance
    if (!gl?.parser) return { ok: false }

    const state = await tickingList()
    if (state?.areas.some(a => a.name === name)) return { ok: true }
    if (state?.full) return { ok: false }

    const r = await gl.exec(`tickingarea add ${from.join(" ")} ${to.join(" ")} ${name}`)
    if (gl.parser.captureLine(r.statusMessage, "commands.tickingarea-add-bounds.success") !== null) {
      return { ok: true }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

export async function tickingRemove(name: string): Promise<boolean> {
  try {
    const gl = GameLoop.instance
    if (!gl) return false
    const r = await gl.exec(`tickingarea remove ${name}`)
    return r.statusCode === 0
  } catch {
    return false
  }
}

export async function tickingRemoveAll(): Promise<boolean> {
  try {
    const gl = GameLoop.instance
    if (!gl) return false
    const r = await gl.exec("tickingarea remove_all")
    return r.statusCode === 0
  } catch {
    return false
  }
}

export function tickingFillChunk(
  chunkX: number, chunkZ: number,
  minY = -64, maxY = 319
): void {
  const gl = GameLoop.instance
  if (!gl) return

  const bx = chunkX * 16
  const bz = chunkZ * 16

  gl.fire(`fill ${bx} ${minY} ${bz} ${bx + 15} ${minY} ${bz + 15} barrier`)
  gl.fire(`fill ${bx} ${maxY} ${bz} ${bx + 15} ${maxY} ${bz + 15} barrier`)
  gl.fire(`fill ${bx} ${minY} ${bz} ${bx} ${maxY} ${bz + 15} barrier`)
  gl.fire(`fill ${bx + 15} ${minY} ${bz} ${bx + 15} ${maxY} ${bz + 15} barrier`)
  gl.fire(`fill ${bx} ${minY} ${bz} ${bx + 15} ${maxY} ${bz} barrier`)
  gl.fire(`fill ${bx} ${minY} ${bz + 15} ${bx + 15} ${maxY} ${bz + 15} barrier`)

  const mid1 = Math.floor(minY + (maxY - minY) / 3)
  const mid2 = Math.floor(minY + 2 * (maxY - minY) / 3)
  gl.fire(`fill ${bx + 1} ${minY + 1} ${bz + 1} ${bx + 14} ${mid1} ${bz + 14} air`)
  gl.fire(`fill ${bx + 1} ${mid1 + 1} ${bz + 1} ${bx + 14} ${mid2} ${bz + 14} air`)
  gl.fire(`fill ${bx + 1} ${mid2 + 1} ${bz + 1} ${bx + 14} ${maxY - 1} ${bz + 14} air`)
}
