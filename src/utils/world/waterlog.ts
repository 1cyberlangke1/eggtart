import { GameLoop } from "../core/game-loop.js"

const SLOT_Y = 0
const SPONGE_OFFSET = 1
const SLOTS_PER_ROW = 5
const SLOT_SPACING = 3

function slotPos(slot: number): { clone: [number, number, number]; sponge: [number, number, number] } {
  const col = slot % SLOTS_PER_ROW
  const row = Math.floor(slot / SLOTS_PER_ROW)
  const cx = 1 + col * SLOT_SPACING
  const cz = 1 + row * SLOT_SPACING
  return {
    clone: [cx, SLOT_Y, cz] as [number, number, number],
    sponge: [cx + SPONGE_OFFSET, SLOT_Y, cz] as [number, number, number],
  }
}

async function checkOne(
  x: number, y: number, z: number, slot: number
): Promise<boolean | null> {
  const gl = GameLoop.instance
  if (!gl) return null

  const { clone, sponge } = slotPos(slot)

  try {
    await gl.exec(`setblock ${clone[0]} ${clone[1]} ${clone[2]} air replace`)
    await gl.exec(`setblock ${sponge[0]} ${sponge[1]} ${sponge[2]} air replace`)

    const cr = await gl.exec(`clone ${x} ${y} ${z} ${x} ${y} ${z} ${clone[0]} ${clone[1]} ${clone[2]}`)
    if (cr.statusCode !== 0) return null

    await gl.exec(`setblock ${sponge[0]} ${sponge[1]} ${sponge[2]} sponge`)

    const tr = await gl.exec(`testforblock ${sponge[0]} ${sponge[1]} ${sponge[2]} wet_sponge`)
    return tr.statusCode === 0
  } finally {
    gl.fire(`setblock ${clone[0]} ${clone[1]} ${clone[2]} air replace`)
    gl.fire(`setblock ${sponge[0]} ${sponge[1]} ${sponge[2]} air replace`)
  }
}

export async function waterlogCheck(
  x: number, y: number, z: number
): Promise<boolean | null> {
  const gl = GameLoop.instance
  if (!gl?.tickingReady) return null
  return checkOne(x, y, z, 0)
}

export async function waterlogBatch(
  positions: Array<[number, number, number]>
): Promise<Array<boolean | null>> {
  const gl = GameLoop.instance
  if (!gl?.tickingReady) return positions.map(() => null)

  const maxSlots = SLOTS_PER_ROW * SLOTS_PER_ROW
  const results: Array<boolean | null> = []

  for (let offset = 0; offset < positions.length; offset += maxSlots) {
    const chunk = positions.slice(offset, offset + maxSlots)
    const batch = chunk.map(([x, y, z], i) => checkOne(x, y, z, i))
    const partial = await Promise.all(batch)
    results.push(...partial)
  }

  return results
}
