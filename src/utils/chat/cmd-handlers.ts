import { regionManager } from "../world/region.js"

export function handleSetp1(x: number, y: number, z: number): Promise<string | null> {
  if (!regionManager.setP1(x, y, z)) return Promise.resolve("该位置在常加载区块内")
  return Promise.resolve(null)
}

export function handleSetp2(x: number, y: number, z: number): Promise<string | null> {
  if (!regionManager.setP2(x, y, z)) return Promise.resolve("该位置在常加载区块内")
  return Promise.resolve(null)
}

export function handleCreate(name?: string): Promise<string | null> {
  const r = regionManager.createRegion(name)
  if (r === null) return Promise.resolve(null)
  if (r === "too_large") return Promise.resolve(`区域过大，上限 ${regionManager.regionMaxSize.join("×")}`)
  if (r === "max_regions") return Promise.resolve("最多 5 个区域")
  if (r === "overlaps_ticking") return Promise.resolve("区域与常加载区块重叠")
  return Promise.resolve(null)
}

export function handleDelRegion(name: string): Promise<string | null> {
  if (!regionManager.deleteRegion(name)) return Promise.resolve(`找不到区域 ${name}`)
  return Promise.resolve(null)
}

export function handleListRegions(): string {
  const list = regionManager.listRegions()
  if (list.length === 0) return "暂无已保存的区域"
  return list.map(r => {
    const [mx, Mx] = r.p1[0] < r.p2[0] ? [r.p1[0], r.p2[0]] : [r.p2[0], r.p1[0]]
    const [my, My] = r.p1[1] < r.p2[1] ? [r.p1[1], r.p2[1]] : [r.p2[1], r.p1[1]]
    const [mz, Mz] = r.p1[2] < r.p2[2] ? [r.p1[2], r.p2[2]] : [r.p2[2], r.p1[2]]
    const size = `${Mx - mx + 1}×${My - my + 1}×${Mz - mz + 1}`
    return `${r.name}: (${r.p1.join(",")}) ~ (${r.p2.join(",")}) [${size}]`
  }).join("\n")
}

export async function handleCreateRegionAt(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  name?: string,
): Promise<string | null> {
  const m1 = await handleSetp1(x1, y1, z1)
  if (m1 !== null) return m1
  const m2 = await handleSetp2(x2, y2, z2)
  if (m2 !== null) return m2
  return handleCreate(name)
}
