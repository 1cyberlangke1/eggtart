import { ItemInteractMethod, type ItemInteractedSignal } from "socket-be"
import { GameLoop } from "../core/game-loop.js"
import { regionManager, boxEdges } from "./region.js"
import { log } from "../logger.js"
import { type Region } from "./region.js"

const MARKER = "eggtart_del_marker"
const TP_INTERVAL = 300
const BOX_INTERVAL = 500
const DEBOUNCE_MS = 200
const EDGE_STEP = 0.5
const PARTICLE = "minecraft:basic_flame_particle"
const WOODEN_SWORD = "minecraft:wooden_sword"

function isInRegion(r: Region, x: number, y: number, z: number): boolean {
  const [mx, Mx] = r.p1[0] < r.p2[0] ? [r.p1[0], r.p2[0]] : [r.p2[0], r.p1[0]]
  const [my, My] = r.p1[1] < r.p2[1] ? [r.p1[1], r.p2[1]] : [r.p2[1], r.p1[1]]
  const [mz, Mz] = r.p1[2] < r.p2[2] ? [r.p1[2], r.p2[2]] : [r.p2[2], r.p1[2]]
  return x >= mx && x <= Mx && y >= my && y <= My && z >= mz && z <= Mz
}

function findNewestRegion(x: number, y: number, z: number): Region | null {
  let match: Region | null = null
  for (const r of regionManager.regions.values()) {
    if (isInRegion(r, x, y, z)) {
      match = r
    }
  }
  return match
}

export class RegionDeleter {
  enabled = true
  private holding = false
  private lastTargetPos: [number, number, number] | null = null

  private tpTimer: ReturnType<typeof setInterval> | null = null
  private boxTimer: ReturnType<typeof setInterval> | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null

  startTimers(): void {
    this.tpTimer = setInterval(() => { void this.tpLoop() }, TP_INTERVAL)
    this.boxTimer = setInterval(() => { this.boxLoop() }, BOX_INTERVAL)
  }

  onItemInteracted(ev: ItemInteractedSignal): void {
    if (ev.method !== ItemInteractMethod.Use) return
    if (ev.itemStack?.typeId !== WOODEN_SWORD) return
    this.tryDelete()
  }

  stop(): void {
    this.holding = false
    this.lastTargetPos = null
    this.clearTimers()
    GameLoop.instance?.fire(`kill @e[name=${MARKER}]`)
  }

  setEnabled(v: boolean): void {
    this.enabled = v
    if (!v) {
      this.holding = false
      this.lastTargetPos = null
      GameLoop.instance?.fire(`kill @e[name=${MARKER}]`)
    }
  }

  private clearTimers(): void {
    if (this.tpTimer) { clearInterval(this.tpTimer); this.tpTimer = null }
    if (this.boxTimer) { clearInterval(this.boxTimer); this.boxTimer = null }
  }

  private async tpLoop(): Promise<void> {
    const gl = GameLoop.instance
    if (!gl || !this.enabled) return
    try {
      const r = await gl.exec(`testfor @a[name=${gl.playerName},hasitem={location=slot.weapon.mainhand,item=wooden_sword}]`)
      const had = this.holding
      this.holding = r.statusCode === 0

      if (!this.holding && had) {
        gl.fire(`kill @e[name=${MARKER}]`)
        this.lastTargetPos = null
        return
      }
      if (!this.holding) return

      const tpOk = await gl.exec(`execute as @a[name=${gl.playerName}] at @s positioned ^ ^2 ^4 run tp @e[name=${MARKER},c=1] ~ ~ ~`)
        .then(r2 => r2.statusCode === 0).catch(() => false)
      if (!tpOk) {
        await gl.exec(`execute as @a[name=${gl.playerName}] at @s run summon armor_stand ~ ~ ~ 0 0 "" ${MARKER}`)
        gl.fire(`effect @e[name=${MARKER},c=1] slow_falling 999999 1 true`)
        await gl.exec(`execute as @a[name=${gl.playerName}] at @s positioned ^ ^2 ^4 run tp @e[name=${MARKER},c=1] ~ ~ ~`)
      }

      const qr = await gl.exec(`querytarget @e[name=${MARKER},c=1]`)
      const raw = qr.statusMessage
      const s = raw.indexOf("[")
      const e = raw.lastIndexOf("]")
      if (s < 0 || e < 0) return
      try {
        const arr = JSON.parse(raw.slice(s, e + 1)) as Array<{ position: { x: number; y: number; z: number } }>
        if (Array.isArray(arr) && arr.length > 0 && arr[0]?.position) {
          const p = arr[0].position
          this.lastTargetPos = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
        }
      } catch { /* skip parse error */ }
    } catch { /* silent */ }
  }

  private boxLoop(): void {
    if (!this.lastTargetPos || !this.holding || !this.enabled) return
    const gl = GameLoop.instance
    if (!gl) return
    const [x, y, z] = this.lastTargetPos
    const pts = boxEdges(x, y, z, x + 1, y + 1, z + 1, EDGE_STEP)
    for (const [px, py, pz] of pts) {
      gl.fire(`particle ${PARTICLE} ${px.toFixed(1)} ${py.toFixed(1)} ${pz.toFixed(1)}`)
    }

    const region = findNewestRegion(x, y, z)
    if (region) {
      gl.fire(`title @a actionbar §c右击 → 删除 §7${region.name} §7- ${x} ${y} ${z}`)
    } else {
      gl.fire(`title @a actionbar §c右击 → 删除区域 §7- ${x} ${y} ${z}`)
    }
  }

  private tryDelete(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      if (!this.lastTargetPos || !this.holding) return

      const gl = GameLoop.instance
      const [x, y, z] = this.lastTargetPos
      const region = findNewestRegion(x, y, z)

      if (!region) {
        gl?.fire(`title @a actionbar §c该位置无区域: ${x} ${y} ${z}`)
        return
      }

      regionManager.deleteRegion(region.name)
      log.success(`已删除区域 ${region.name} (${x},${y},${z})`, { color: "red", prefix: "Del" })
      gl?.fire(`title @a actionbar §a已删除区域 ${region.name}`)
    }, DEBOUNCE_MS)
  }
}
