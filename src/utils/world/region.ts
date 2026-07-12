import { GameLoop, Lane } from "../core/game-loop.js"
import { log } from "../logger.js"

const PARTICLE_ENDROD = "minecraft:endrod"
const EDGE_STEP = 0.5
const REFRESH_MS = 2000
const MAX_REGIONS = 5

export interface Region {
  name: string
  p1: [number, number, number]
  p2: [number, number, number]
}

function fmtPos(n: number): string {
  return n.toFixed(1)
}

export function edgeParticles(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  step: number,
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const count = Math.max(1, Math.round(len / step))
  for (let i = 0; i <= count; i++) {
    const t = i / count
    out.push([ax + dx * t, ay + dy * t, az + dz * t])
  }
  return out
}

export function boxEdges(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  step: number,
): Array<[number, number, number]> {
  const [mx, Mx] = x1 < x2 ? [x1, x2] : [x2, x1]
  const [my, My] = y1 < y2 ? [y1, y2] : [y2, y1]
  const [mz, Mz] = z1 < z2 ? [z1, z2] : [z2, z1]
  const out: Array<[number, number, number]> = []
  out.push(...edgeParticles(mx, my, mz, Mx, my, mz, step))
  out.push(...edgeParticles(Mx, my, mz, Mx, my, Mz, step))
  out.push(...edgeParticles(Mx, my, Mz, mx, my, Mz, step))
  out.push(...edgeParticles(mx, my, Mz, mx, my, mz, step))
  out.push(...edgeParticles(mx, My, mz, Mx, My, mz, step))
  out.push(...edgeParticles(Mx, My, mz, Mx, My, Mz, step))
  out.push(...edgeParticles(Mx, My, Mz, mx, My, Mz, step))
  out.push(...edgeParticles(mx, My, Mz, mx, My, mz, step))
  out.push(...edgeParticles(mx, my, mz, mx, My, mz, step))
  out.push(...edgeParticles(Mx, my, mz, Mx, My, mz, step))
  out.push(...edgeParticles(Mx, my, Mz, Mx, My, Mz, step))
  out.push(...edgeParticles(mx, my, Mz, mx, My, Mz, step))
  return out
}

export async function getPlayerPosition(): Promise<[number, number, number] | null> {
  const gl = GameLoop.instance
  if (!gl) return null
  const r = await gl.exec(`querytarget @a[name=${gl.playerName},c=1]`)
  const raw = r.statusMessage
  const s = raw.indexOf("[")
  const e = raw.lastIndexOf("]")
  if (s < 0 || e < 0) return null
  try {
    const arr = JSON.parse(raw.slice(s, e + 1)) as Array<{ position: { x: number; y: number; z: number } }>
    if (Array.isArray(arr) && arr.length > 0 && arr[0]?.position) {
      const p = arr[0].position
      return [Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)]
    }
  } catch { /* skip parse error */ }
  return null
}

type RegionLaneData = { timer: ReturnType<typeof setInterval> }

class RegionManager {
  currentP1: [number, number, number] | null = null
  currentP2: [number, number, number] | null = null
  readonly regions = new Map<string, Region>()
  regionMaxSize: [number, number, number] = [50, 50, 50]
  tickingAreaFrom: [number, number, number] | null = null
  tickingAreaTo: [number, number, number] | null = null
  private p1Lane: Lane | null = null
  private p2Lane: Lane | null = null
  private regionLane: Lane | null = null
  private readonly pending = new Set<string>()
  private autoId = 0

  private p1Timer: ReturnType<typeof setInterval> | null = null
  private p2Timer: ReturnType<typeof setInterval> | null = null
  private readonly regionData = new Map<string, RegionLaneData>()

  createLanes(): void {
    const gl = GameLoop.instance
    if (!gl) return
    this.p1Lane = gl.createLane(1)
    this.p2Lane = gl.createLane(1)
    this.regionLane = gl.createLane(5)
  }

  stopAll(): void {
    this.clearP1Timer()
    this.clearP2Timer()
    for (const { timer } of this.regionData.values()) {
      clearInterval(timer)
    }
    this.regionData.clear()
  }

  isInTickingArea(x: number, y: number, z: number): boolean {
    if (!this.tickingAreaFrom || !this.tickingAreaTo) return false
    return x >= this.tickingAreaFrom[0] && x <= this.tickingAreaTo[0]
      && y >= this.tickingAreaFrom[1] && y <= this.tickingAreaTo[1]
      && z >= this.tickingAreaFrom[2] && z <= this.tickingAreaTo[2]
  }

  setP1(x: number, y: number, z: number): boolean {
    if (this.isInTickingArea(x, y, z)) return false
    this.currentP1 = [x, y, z]
    this.clearP1Timer()
    this.refreshP1()
    this.p1Timer = setInterval(() => { this.refreshP1() }, REFRESH_MS)
    log.success(`点1 已设 (${x},${y},${z})`)
    return true
  }

  setP2(x: number, y: number, z: number): boolean {
    if (this.isInTickingArea(x, y, z)) return false
    this.currentP2 = [x, y, z]
    this.clearP2Timer()
    this.refreshP2()
    this.p2Timer = setInterval(() => { this.refreshP2() }, REFRESH_MS)
    log.success(`点2 已设 (${x},${y},${z})`)
    return true
  }

  overlapsTickingArea(mx: number, my: number, mz: number, Mx: number, My: number, Mz: number): boolean {
    const ta = this.tickingAreaFrom
    const tb = this.tickingAreaTo
    if (!ta || !tb) return false
    return mx <= tb[0] && Mx >= ta[0]
      && my <= tb[1] && My >= ta[1]
      && mz <= tb[2] && Mz >= ta[2]
  }

  createRegion(name?: string): Region | null | "too_large" | "max_regions" | "overlaps_ticking" {
    if (!this.currentP1 || !this.currentP2) return null
    if (this.regions.size >= MAX_REGIONS) return "max_regions"

    const [mx, Mx] = this.currentP1[0] < this.currentP2[0] ? [this.currentP1[0], this.currentP2[0]] : [this.currentP2[0], this.currentP1[0]]
    const [my, My] = this.currentP1[1] < this.currentP2[1] ? [this.currentP1[1], this.currentP2[1]] : [this.currentP2[1], this.currentP1[1]]
    const [mz, Mz] = this.currentP1[2] < this.currentP2[2] ? [this.currentP1[2], this.currentP2[2]] : [this.currentP2[2], this.currentP1[2]]
    const dx = Mx - mx + 1
    const dy = My - my + 1
    const dz = Mz - mz + 1
    if (dx > this.regionMaxSize[0] || dy > this.regionMaxSize[1] || dz > this.regionMaxSize[2]) return "too_large"
    if (this.overlapsTickingArea(mx, my, mz, Mx, My, Mz)) return "overlaps_ticking"

    const n = name ?? `region_${++this.autoId}`
    const region: Region = {
      name: n,
      p1: [this.currentP1[0], this.currentP1[1], this.currentP1[2]],
      p2: [this.currentP2[0], this.currentP2[1], this.currentP2[2]],
    }
    this.regions.set(n, region)
    this.currentP1 = null
    this.currentP2 = null
    this.clearP1Timer()
    this.clearP2Timer()

    log.success(`区域 ${n} 已创建 (${region.p1.join(",")} ~ ${region.p2.join(",")})`)
    this.refreshAll()
    const timer = setInterval(() => { this.refreshAll() }, REFRESH_MS)
    this.regionData.set(n, { timer })
    return region
  }

  deleteRegion(name: string): boolean {
    const data = this.regionData.get(name)
    if (data) {
      clearInterval(data.timer)
      this.regionData.delete(name)
    }
    const ok = this.regions.delete(name)
    if (ok) {
      this.refreshAll()
      log.success(`区域 ${name} 已删除`)
    }
    return ok
  }

  listRegions(): Region[] {
    return [...this.regions.values()]
  }

  private clearP1Timer(): void {
    if (this.p1Timer) { clearInterval(this.p1Timer); this.p1Timer = null }
  }

  private clearP2Timer(): void {
    if (this.p2Timer) { clearInterval(this.p2Timer); this.p2Timer = null }
  }

  private refreshP1(): void {
    if (!this.currentP1) return
    const [x, y, z] = this.currentP1
    const pts = boxEdges(x, y, z, x + 1, y + 1, z + 1, EDGE_STEP)
    for (const [px, py, pz] of pts) this.fireParticle(px, py, pz, PARTICLE_ENDROD, this.p1Lane)
  }

  private refreshP2(): void {
    if (!this.currentP2) return
    const [x, y, z] = this.currentP2
    const pts = boxEdges(x, y, z, x + 1, y + 1, z + 1, EDGE_STEP)
    for (const [px, py, pz] of pts) this.fireParticle(px, py, pz, PARTICLE_ENDROD, this.p2Lane)
  }

  private refreshAll(): void {
    for (const name of this.regions.keys()) this.refreshRegion(name)
  }

  private refreshRegion(name: string): void {
    const r = this.regions.get(name)
    if (!r) return
    const [mx, Mx] = r.p1[0] < r.p2[0] ? [r.p1[0], r.p2[0]] : [r.p2[0], r.p1[0]]
    const [my, My] = r.p1[1] < r.p2[1] ? [r.p1[1], r.p2[1]] : [r.p2[1], r.p1[1]]
    const [mz, Mz] = r.p1[2] < r.p2[2] ? [r.p1[2], r.p2[2]] : [r.p2[2], r.p1[2]]
    const pts = boxEdges(mx, my, mz, Mx + 1, My + 1, Mz + 1, EDGE_STEP)
    for (const [px, py, pz] of pts) this.fireParticle(px, py, pz, PARTICLE_ENDROD, this.regionLane)
  }

  private fireParticle(x: number, y: number, z: number, type: string, lane: Lane | null): void {
    if (!lane) return
    const key = `${fmtPos(x)} ${fmtPos(y)} ${fmtPos(z)} ${type}`
    if (this.pending.has(key)) return
    this.pending.add(key)
    lane.exec(`particle ${type} ${fmtPos(x)} ${fmtPos(y)} ${fmtPos(z)}`)
      .catch(() => {})
      .finally(() => { this.pending.delete(key) })
  }
}

export const regionManager = new RegionManager()
