import { ItemInteractMethod, type ItemInteractedSignal } from "socket-be"
import { GameLoop } from "../core/game-loop.js"
import { regionManager, boxEdges } from "./region.js"

const MARKER = "eggtart_marker"
const TP_INTERVAL = 300
const BOX_INTERVAL = 500
const DEBOUNCE_MS = 200
const EDGE_STEP = 0.5

export class SwordTracker {
  enabled = true
  private holding = false
  private lastTargetPos: [number, number, number] | null = null
  private selectState: "p1" | "p2" | "create" = "p1"

  private tpTimer: ReturnType<typeof setInterval> | null = null
  private boxTimer: ReturnType<typeof setInterval> | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null

  startTimers(): void {
    this.tpTimer = setInterval(() => { void this.tpLoop() }, TP_INTERVAL)
    this.boxTimer = setInterval(() => { this.boxLoop() }, BOX_INTERVAL)
  }

  onItemInteracted(ev: ItemInteractedSignal): void {
    if (ev.method !== ItemInteractMethod.Use) return
    if (ev.itemStack?.typeId !== "minecraft:netherite_sword") return
    this.trySetp()
  }

  stop(): void {
    this.holding = false
    this.lastTargetPos = null
    this.selectState = "p1"
    this.clearTimers()
    GameLoop.instance?.fire(`kill @e[name=${MARKER}]`)
  }

  setEnabled(v: boolean): void {
    this.enabled = v
    if (!v) {
      this.holding = false
      this.lastTargetPos = null
      this.selectState = "p1"
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
      const r = await gl.exec(`testfor @a[name=${gl.playerName},hasitem={location=slot.weapon.mainhand,item=netherite_sword}]`)
      const had = this.holding
      this.holding = r.statusCode === 0

      if (!this.holding && had) {
        gl.fire(`kill @e[name=${MARKER}]`)
        this.lastTargetPos = null
        return
      }
      if (!this.holding) return

      const tpOk = await gl.exec(`execute as @a[name=${gl.playerName}] at @s positioned ^ ^2 ^4 run tp @e[name=${MARKER}] ~ ~ ~`)
        .then(r2 => r2.statusCode === 0).catch(() => false)
      if (!tpOk) {
        await gl.exec(`execute as @a[name=${gl.playerName}] at @s run summon armor_stand ~ ~ ~ 0 0 "" ${MARKER}`)
        gl.fire(`effect @e[name=${MARKER}] slow_falling 999999 1 true`)
        await gl.exec(`execute as @a[name=${gl.playerName}] at @s positioned ^ ^2 ^4 run tp @e[name=${MARKER}] ~ ~ ~`)
      }

      const qr = await gl.exec(`querytarget @e[name=${MARKER}]`)
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
      gl.fire(`particle minecraft:endrod ${px.toFixed(1)} ${py.toFixed(1)} ${pz.toFixed(1)}`)
    }
    const label = this.selectState === "p1" ? "§e右击 → 选点1" : this.selectState === "p2" ? "§e右击 → 选点2" : "§e右击 → §b创建区域"
    gl.fire(`title @a actionbar ${label} §7- ${x} ${y} ${z}`)
  }

  private trySetp(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      if (!this.lastTargetPos || !this.holding) return

      const gl = GameLoop.instance
      if (!gl) return
      const [x, y, z] = this.lastTargetPos

      if (regionManager.isInTickingArea(x, y, z)) {
        gl.fire(`title @a actionbar §c常加载区块内禁用选点`)
        this.selectState = "p1"
        return
      }

      switch (this.selectState) {
        case "p1":
          if (!regionManager.setP1(x, y, z)) {
            gl.fire(`title @a actionbar §c选区失败`)
            return
          }
          gl.fire(`title @a actionbar §a点1 已选: ${x} ${y} ${z}`)
          this.selectState = "p2"
          break

        case "p2":
          if (!regionManager.setP2(x, y, z)) {
            gl.fire(`title @a actionbar §c选区失败`)
            return
          }
          gl.fire(`title @a actionbar §a点2 已选: ${x} ${y} ${z}`)
          this.selectState = "create"
          break

        case "create": {
          const r = regionManager.createRegion()
          if (r === null) {
            gl.fire(`title @a actionbar §c创建失败: 先选两点`)
          } else if (r === "too_large") {
            gl.fire(`title @a actionbar §c创建失败: 区域过大`)
          } else if (r === "max_regions") {
            gl.fire(`title @a actionbar §c创建失败: 区域已达上限`)
          } else if (r === "overlaps_ticking") {
            gl.fire(`title @a actionbar §c创建失败: 与常加载区域重叠`)
          } else {
            gl.fire(`title @a actionbar §a区域 ${r.name} 已创建!`)
          }
          this.selectState = "p1"
          break
        }
      }
    }, DEBOUNCE_MS)
  }
}
