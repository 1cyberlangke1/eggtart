import { Server, ServerEvent, World, WorldInitializeSignal, type CommandResult } from "socket-be"
import { type CmdParser } from "../reader/cmd-parser.js"

interface ExecItem {
  cmd: string
  resolve: (r: { statusCode: number; statusMessage: string }) => void
  reject: (e: Error) => void
}

export class Lane {
  readonly queue: ExecItem[] = []
  activeCount = 0
  readonly capacity: number

  constructor(private game: GameLoop, capacity = 1) {
    this.capacity = capacity
  }

  exec(cmd: string): Promise<{ statusCode: number; statusMessage: string }> {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, resolve, reject })
      this.game.drain()
    })
  }
}

export class GameLoop {
  static instance: GameLoop | null = null

  readonly lanes: Lane[] = []
  parser: CmdParser | null = null
  lang: string | null = null
  playerName = ""
  blocks: Record<string, string> | null = null
  blockStateMap: Record<string, { blocks: string[]; values: string }> | null = null
  tickingReady = false
  waterloggableBlocks: Set<string> | null = null

  private world: World | null = null
  readonly maxPending: number
  private publicQueue: ExecItem[] = []
  private publicAwaited = 0

  constructor(server: Server, maxPending = 100) {
    GameLoop.instance = this
    this.maxPending = maxPending

    server.on(ServerEvent.WorldInitialize, (ev: WorldInitializeSignal) => {
      this.world = ev.world
      this.drain()
    })

    server.on(ServerEvent.Close, () => {
      this.destroy()
    })
  }

  exec(cmd: string): Promise<{ statusCode: number; statusMessage: string }> {
    return new Promise((resolve, reject) => {
      this.publicQueue.push({ cmd, resolve, reject })
      if (this.world) this.drain()
    })
  }

  fire(cmd: string): void {
    this.exec(cmd).catch(() => {})
  }

  createLane(slots = 1): Lane {
    const reserved = this.lanes.reduce((s, l) => s + l.capacity, 0)
    const remaining = this.maxPending - reserved
    if (remaining - slots < 1) {
      throw new Error(
        `createLane(${slots}) failed: need ${slots} slots, ` +
        `only ${remaining - 1} available (maxPending=${this.maxPending}, ` +
        `reserved=${reserved}, need ≥1 for public pool)`
      )
    }
    const lane = new Lane(this, slots)
    this.lanes.push(lane)
    return lane
  }

  drain(): void {
    const world = this.world
    if (!world) return

    for (const lane of this.lanes) {
      if (lane.activeCount >= lane.capacity) continue
      if (lane.queue.length === 0) continue
      const item = lane.queue.shift() as ExecItem
      lane.activeCount++
      world.runCommand(item.cmd)
        .then((r: CommandResult<Record<string, unknown>>) => { item.resolve(r) })
        .catch((e: unknown) => { item.reject(e as Error) })
        .finally(() => {
          lane.activeCount--
          this.drain()
        })
    }

    const reserved = this.lanes.reduce((s, l) => s + l.capacity, 0)
    const publicCap = Math.max(1, this.maxPending - reserved)
    while (this.publicQueue.length > 0 && this.publicAwaited < publicCap) {
      const item = this.publicQueue.shift() as ExecItem
      this.publicAwaited++
      world.runCommand(item.cmd)
        .then((r: CommandResult<Record<string, unknown>>) => { item.resolve(r) })
        .catch((e: unknown) => { item.reject(e as Error) })
        .finally(() => {
          this.publicAwaited--
          this.drain()
        })
    }
  }

  destroy(): void {
    const err = new Error("GameLoop destroyed")

    for (const item of this.publicQueue) item.reject(err)
    this.publicQueue = []
    this.publicAwaited = 0

    for (const lane of this.lanes) {
      for (const item of lane.queue) item.reject(err)
      lane.queue.length = 0
      lane.activeCount = 0
    }

    this.world = null
  }
}
