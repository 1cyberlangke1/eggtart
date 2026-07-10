import { readFileSync, existsSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { fileURLToPath } from "url"
import { CmdParser } from "../reader/cmd-parser.js"
import { log } from "../logger.js"

const DATA_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "data")

// 只存 footer 原文 → 语言名，不存完整 commands
const footerMap = new Map<string, string>()

for (const langDir of readdirSync(DATA_DIR)) {
  const cp = join(DATA_DIR, langDir, "commands.json")
  if (!existsSync(cp)) continue
  try {
    const cmds = JSON.parse(readFileSync(cp, "utf-8")) as Record<string, string>
    const footer = cmds["commands.help.footer"]
    if (footer) footerMap.set(footer, langDir)
  } catch {
    // skip
  }
}

log.info(`已索引 ${footerMap.size} 个语言 (footers)`, { prefix: "Lang" })

export interface LangInfo {
  lang: string
  parser: CmdParser
}

export function detectLanguage(helpMsg: string): LangInfo | null {
  for (const [footer, langDir] of footerMap) {
    if (!helpMsg.includes(footer)) continue
    const cp = join(DATA_DIR, langDir, "commands.json")
    try {
      const cmds = JSON.parse(readFileSync(cp, "utf-8")) as Record<string, string>
      log.info(`匹配成功: ${langDir} (${cp})`, { prefix: "Lang" })
      return { lang: langDir, parser: new CmdParser(cmds) }
    } catch {
      return null
    }
  }
  return null
}
