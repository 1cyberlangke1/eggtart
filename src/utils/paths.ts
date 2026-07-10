import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { existsSync } from "fs"

function findRoot(from: string): string {
  let dir = dirname(from)
  for (let i = 0; i < 20; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir
    dir = resolve(dir, "..")
  }
  throw new Error("无法定位项目根目录（向上 20 层未找到 package.json）")
}

const ROOT = findRoot(fileURLToPath(import.meta.url))
export const DATA_DIR = resolve(ROOT, "src", "data")
export const PROJECT_ROOT = ROOT
