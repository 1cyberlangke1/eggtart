import { GameLoop } from "./core/game-loop.js"

export type McColor =
  | "black" | "dark_blue" | "dark_green" | "dark_aqua"
  | "dark_red" | "dark_purple" | "gold" | "gray"
  | "dark_gray" | "blue" | "green" | "aqua"
  | "red" | "light_purple" | "yellow" | "white"

const MC_CODE: Record<McColor, string> = {
  black: "0",
  dark_blue: "1",
  dark_green: "2",
  dark_aqua: "3",
  dark_red: "4",
  dark_purple: "5",
  gold: "6",
  gray: "7",
  dark_gray: "8",
  blue: "9",
  green: "a",
  aqua: "b",
  red: "c",
  light_purple: "d",
  yellow: "e",
  white: "f",
}

const ANSI_CODE: Record<McColor, string> = {
  black: "30",
  dark_blue: "34",
  dark_green: "32",
  dark_aqua: "36",
  dark_red: "31",
  dark_purple: "35",
  gold: "33",
  gray: "37",
  dark_gray: "90",
  blue: "94",
  green: "92",
  aqua: "96",
  red: "91",
  light_purple: "95",
  yellow: "93",
  white: "97",
}

export interface LogOpts {
  color?: McColor
  game?: boolean
  prefix?: string
}

export class Logger {
  constructor(private name: string) {}

  info(msg: string, opts?: LogOpts): void {
    this.print(msg, "white", opts)
  }

  success(msg: string, opts?: LogOpts): void {
    this.print(msg, "green", opts)
  }

  warn(msg: string, opts?: LogOpts): void {
    this.print(msg, "yellow", opts)
  }

  error(msg: string, opts?: LogOpts): void {
    this.print(msg, "red", opts)
  }

  debug(msg: string, opts?: LogOpts): void {
    this.print(msg, "gray", opts)
  }

  raw(msg: string, opts?: LogOpts): void {
    this.printRaw(msg, opts)
  }

  private print(msg: string, defaultColor: McColor, opts?: LogOpts): void {
    const color = opts?.color ?? defaultColor
    const name = opts?.prefix ?? this.name
    const mc = MC_CODE[color]
    const ansi = ANSI_CODE[color]
    console.log(`\x1b[${ansi}m[${name}]\x1b[0m ${msg}`)
    if (opts?.game ?? true) this.toGame(mc, msg, name)
  }

  private printRaw(msg: string, opts?: LogOpts): void {
    const color = opts?.color ?? "white"
    const name = opts?.prefix ?? this.name
    const mc = MC_CODE[color]
    const ansi = ANSI_CODE[color]
    console.log(`\x1b[${ansi}m${msg}\x1b[0m`)
    if (opts?.game ?? true) this.toGame(mc, msg, name, false)
  }

  private toGame(colorCode: string, msg: string, name: string, showPrefix = true): void {
    const gl = GameLoop.instance
    if (!gl?.playerName) return
    const prefixPart = showPrefix ? `§${colorCode}<${name}> §r` : ""
    const payload = JSON.stringify({ rawtext: [{ text: `${prefixPart}${msg}` }] })
    gl.exec(`tellraw ${gl.playerName} ${payload}`).catch(() => {})
  }
}

export const log = new Logger("EggTart")
