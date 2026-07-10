import vm from "node:vm"
import { GameLoop } from "../core/game-loop.js"
import { type Region } from "./region.js"

export interface ScriptResult {
  total: number
  timedOut: boolean
}

function quoteValue(v: string): string {
  return /^\d+$|^true$|^false$/i.test(v) ? v : `"${v}"`
}

export function runScript(region: Region, script: string, timeout = 30): ScriptResult {
  const gl = GameLoop.instance
  if (!gl) throw new Error("GameLoop not initialized")

  const mx = Math.min(region.p1[0], region.p2[0])
  const my = Math.min(region.p1[1], region.p2[1])
  const mz = Math.min(region.p1[2], region.p2[2])
  const ox = mx
  const oy = my
  const oz = mz

  const commands: Array<{
    type: "setblock" | "fill"
    ax: number; ay: number; az: number
    ax2?: number; ay2?: number; az2?: number
    blockId: string
    states: Record<string, string> | undefined
  }> = []

  function setBlock(rx: number, ry: number, rz: number, blockId: string, states?: Record<string, string>): void {
    commands.push({ type: "setblock", ax: ox + rx, ay: oy + ry, az: oz + rz, blockId, states })
  }

  function fillBlock(rx1: number, ry1: number, rz1: number, rx2: number, ry2: number, rz2: number, blockId: string, states?: Record<string, string>): void {
    commands.push({ type: "fill", ax: ox + rx1, ay: oy + ry1, az: oz + rz1, ax2: ox + rx2, ay2: oy + ry2, az2: oz + rz2, blockId, states })
  }

  const timeoutMs = timeout * 1000
  let timedOut = false

  try {
    vm.runInNewContext(script, { setBlock, fillBlock }, { timeout: timeoutMs })
  } catch (e: unknown) {
    const err = e as Error
    if (err.message.includes("timed out")) {
      timedOut = true
    } else {
      throw err
    }
  }

  for (const cmd of commands) {
    let cmdStr: string
    if (cmd.type === "fill" && cmd.ax2 !== undefined) {
      cmdStr = `fill ${cmd.ax} ${cmd.ay} ${cmd.az} ${cmd.ax2} ${cmd.ay2} ${cmd.az2} ${cmd.blockId}`
    } else {
      cmdStr = `setblock ${cmd.ax} ${cmd.ay} ${cmd.az} ${cmd.blockId}`
    }
    if (cmd.states && Object.keys(cmd.states).length > 0) {
      const parts = Object.entries(cmd.states).map(([k, v]) => `"${k}"=${quoteValue(v)}`)
      cmdStr += ` [${parts.join(",")}]`
    }
    gl.fire(cmdStr)
  }

  return { total: commands.length, timedOut }
}
