import { type CmdArg } from "./chat/chat-handler.js"
import { getPlayerPosition } from "./world/region.js"

const COORD_PATTERN = "(-?\\d+|~[+-]?\\d*)"

export function coord(label?: string): CmdArg<string> {
  return { pattern: COORD_PATTERN, parse: s => s, label: label ?? "", typeName: "coord", optional: false }
}

export function optCoord(label?: string): CmdArg<string | undefined> {
  return { pattern: COORD_PATTERN, parse: s => s, label: label ?? "", typeName: "coord", optional: true }
}

export function resolveCoord(raw: string, playerPos: number): number {
  if (raw.startsWith("~")) {
    const offset = raw.slice(1)
    return playerPos + (offset === "" ? 0 : Number(offset))
  }
  return Number(raw)
}

export async function resolveCoords(
  x: string, y: string, z: string
): Promise<[number, number, number]>
export async function resolveCoords(
  x: string | undefined, y: string | undefined, z: string | undefined
): Promise<[number | undefined, number | undefined, number | undefined]>
export async function resolveCoords(
  x?: string, y?: string, z?: string
): Promise<[number | undefined, number | undefined, number | undefined]> {
  if (x !== undefined && y !== undefined && z !== undefined) {
    const hasTilde = x.startsWith("~") || y.startsWith("~") || z.startsWith("~")
    if (hasTilde) {
      const pos = await getPlayerPosition()
      if (!pos) return [undefined, undefined, undefined]
      return [
        resolveCoord(x, pos[0]),
        resolveCoord(y, pos[1]),
        resolveCoord(z, pos[2]),
      ]
    }
    return [Number(x), Number(y), Number(z)]
  }
  if (x !== undefined || y !== undefined || z !== undefined) return [undefined, undefined, undefined]
  const pos = await getPlayerPosition()
  if (!pos) return [undefined, undefined, undefined]
  return [pos[0], pos[1], pos[2]]
}
