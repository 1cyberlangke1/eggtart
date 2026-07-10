import { Server, ServerEvent } from "socket-be"
import { GameLoop } from "../core/game-loop.js"
import { log } from "../logger.js"

export interface CmdArg<T> {
  pattern: string
  parse: (s: string) => T
  label: string
  optional?: boolean
  typeName: string
}

export function int(label?: string): CmdArg<number> {
  return { pattern: "(-?\\d+)", parse: Number, label: label ?? "", typeName: "int", optional: false }
}

export function str(label?: string): CmdArg<string> {
  return { pattern: "(.+?)", parse: s => s, label: label ?? "", typeName: "str", optional: false }
}

export function bool(label?: string): CmdArg<boolean> {
  return { pattern: "(true|false)", parse: s => s === "true", label: label ?? "", typeName: "bool", optional: false }
}

export function optInt(label?: string): CmdArg<number | undefined> {
  return { pattern: "(-?\\d+)", parse: Number, label: label ?? "", typeName: "int", optional: true }
}

export function optStr(label?: string): CmdArg<string | undefined> {
  return { pattern: "(.+?)", parse: s => s, label: label ?? "", typeName: "str", optional: true }
}

export function optBool(label?: string): CmdArg<boolean | undefined> {
  return { pattern: "(true|false)", parse: s => s === "true", label: label ?? "", typeName: "bool", optional: true }
}

type CmdDef = readonly [
  name: string,
  args: ReadonlyArray<CmdArg<unknown>>,
  handler: (...args: unknown[]) => Promise<string | null>,
  description?: string,
]

export function cmd<T extends unknown[]>(
  name: string,
  args: { [K in keyof T]: CmdArg<T[K]> },
  handler: (...args: T) => Promise<string | null>,
  description?: string,
): CmdDef {
  return [name, args, handler, description] as unknown as CmdDef
}

export function registerChatCommands(server: Server, cmds: ReadonlyArray<CmdDef>): void {
  const helpLines = cmds.map(([name, args, , description]) => {
    const argStr = args.map(a => {
      const namePart = a.label || a.typeName
      const opt = a.optional ? "?" : ""
      return `${namePart}:${a.typeName}${opt}`
    }).join(" ")
    const line = `!${name}${argStr ? " " + argStr : ""}`
    return description ? `${line} - ${description}` : line
  })
  const perPage = 10

  server.on(ServerEvent.PlayerChat, async (ev) => {
    const gl = GameLoop.instance
    if (!gl || ev.sender.name !== gl.playerName) return

    const text = ev.message.replace(/§./g, "").trim()

    if (/^!help(\s+\d+)?$/i.test(text)) {
      const pageMatch = text.match(/\d+/)
      const page = pageMatch ? parseInt(pageMatch[0]) : 1
      const total = Math.ceil(helpLines.length / perPage) || 1
      if (page < 1 || page > total) {
        log.error(`页数超出范围 (1~${total})`, { prefix: "Help" })
        return
      }
      const start = (page - 1) * perPage
      const chunk = helpLines.slice(start, start + perPage)
      log.success(`--- 命令帮助 (${page}/${total}) ---`, { prefix: "Help" })
      for (const line of chunk) log.info(line, { color: "gray", prefix: "Help" })
      log.success(`--- !help [页码] 查看更多 ---`, { prefix: "Help" })
      return
    }

    for (const [name, args, handler] of cmds) {
      const argParts = args.map(a =>
        a.optional ? `(?:\\s+${a.pattern})?` : `\\s+${a.pattern}`
      )
      const pattern = `^!${name}${argParts.join("")}$`
      const re = new RegExp(pattern, "i")
      const m = text.match(re)
      if (!m) continue

      const parsed: unknown[] = []
      for (let i = 0; i < args.length; i++) {
        const raw = m[i + 1]
        const arg = args[i]
        if (arg === undefined) return
        if (raw === undefined) {
          parsed.push(undefined)
        } else {
          parsed.push(arg.parse(raw.trim()))
        }
      }

      const result = await handler(...parsed)
      if (result !== null) {
        for (const line of result.split("\n")) {
          if (line) log.success(line, { prefix: name })
        }
      }
      return
    }
  })
}
