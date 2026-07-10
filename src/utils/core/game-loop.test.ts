import { describe, it, expect, vi } from "vitest"
import { Server } from "socket-be"
import { GameLoop, Lane } from "./game-loop.js"

type RunCommand = (cmd: string) => Promise<{ statusCode: number; statusMessage: string }>
type MockWorld = { runCommand: RunCommand }

class MockServer {
  private handlers = new Map<number, Array<(arg?: { world: MockWorld }) => void>>()

  on(event: number, handler: (arg?: { world: MockWorld }) => void) {
    const arr = this.handlers.get(event)
    if (arr) arr.push(handler)
    else this.handlers.set(event, [handler])
    return this
  }

  emit(event: number, arg?: { world: MockWorld }) {
    const arr = this.handlers.get(event)
    if (!arr) return
    for (const h of arr) h(arg)
  }
}

const SE = { WorldInitialize: 4, Close: 1 }

function makeWorld(): { world: MockWorld; deferred: Array<(r: { statusCode: number; statusMessage: string }) => void> } {
  const deferred: Array<(r: { statusCode: number; statusMessage: string }) => void> = []
  const world: MockWorld = {
    runCommand: vi.fn().mockImplementation(() => {
      return new Promise(resolve => { deferred.push(resolve) })
    }) as RunCommand,
  }
  return { world, deferred }
}

function makeGame(maxPending = 100): { gl: GameLoop; server: MockServer } {
  const server = new MockServer()
  const gl = new GameLoop(server as unknown as Server, maxPending)
  return { gl, server }
}

describe("GameLoop", () => {
  it("registers WorldInitialize and Close handlers", () => {
    const server = new MockServer()
    const onSpy = vi.spyOn(server, "on")
    new GameLoop(server as unknown as Server, 100)
    expect(onSpy).toHaveBeenCalledWith(SE.WorldInitialize, expect.any(Function))
    expect(onSpy).toHaveBeenCalledWith(SE.Close, expect.any(Function))
  })

  it("queues commands before WorldInitialize, drains after", async () => {
    const { gl, server } = makeGame()
    const { world, deferred } = makeWorld()
    const p = gl.exec("say hi")

    expect(world.runCommand).toHaveBeenCalledTimes(0)

    server.emit(SE.WorldInitialize, { world })
    expect(world.runCommand).toHaveBeenCalledTimes(1)
    expect(world.runCommand).toHaveBeenCalledWith("say hi")

    const resolve = deferred[0] as (r: { statusCode: number; statusMessage: string }) => void
    resolve({ statusCode: 0, statusMessage: "ok" })
    const r = await p
    expect(r.statusCode).toBe(0)
  })

  it("fire does not throw", () => {
    const { gl, server } = makeGame()
    const { world } = makeWorld()
    server.emit(SE.WorldInitialize, { world })

    expect(() => { gl.fire("say hi") }).not.toThrow()
    expect(world.runCommand).toHaveBeenCalledWith("say hi")
  })

  it("createLane returns Lane with default capacity 1", () => {
    const { gl } = makeGame()
    const lane = gl.createLane()
    expect(lane).toBeInstanceOf(Lane)
    expect(lane.capacity).toBe(1)
  })

  it("createLane(slots) sets capacity", () => {
    const { gl } = makeGame()
    const lane = gl.createLane(5)
    expect(lane.capacity).toBe(5)
  })

  it("limits public concurrency", async () => {
    const { gl, server } = makeGame(2)
    const { world, deferred } = makeWorld()
    server.emit(SE.WorldInitialize, { world })

    void gl.exec("a")
    void gl.exec("b")
    void gl.exec("c")

    expect(world.runCommand).toHaveBeenCalledTimes(2)

    const resolve = deferred[0] as (r: { statusCode: number; statusMessage: string }) => void
    resolve({ statusCode: 0, statusMessage: "a" })
    await vi.waitFor(() => { expect(world.runCommand).toHaveBeenCalledTimes(3) })
  })

  it("Lane reserves slot, not shared with public", () => {
    const { gl, server } = makeGame(3)
    gl.createLane(1)
    const { world } = makeWorld()
    server.emit(SE.WorldInitialize, { world })

    void gl.exec("a")
    void gl.exec("b")
    void gl.exec("c")

    expect(world.runCommand).toHaveBeenCalledTimes(2)
    expect(world.runCommand).toHaveBeenNthCalledWith(1, "a")
    expect(world.runCommand).toHaveBeenNthCalledWith(2, "b")
  })

  it("Lane gets its own slot when public is full", () => {
    const { gl, server } = makeGame(3)
    const lane = gl.createLane(1)
    const { world } = makeWorld()
    server.emit(SE.WorldInitialize, { world })

    void gl.exec("pub1")
    void gl.exec("pub2")
    void gl.exec("pub3")
    expect(world.runCommand).toHaveBeenCalledTimes(2)

    void lane.exec("lane1")
    expect(world.runCommand).toHaveBeenCalledTimes(3)
    expect(world.runCommand).toHaveBeenNthCalledWith(3, "lane1")
  })

  it("Lane queues when at capacity", async () => {
    const { gl, server } = makeGame(10)
    const lane = gl.createLane(2)
    const { world, deferred } = makeWorld()
    server.emit(SE.WorldInitialize, { world })

    void lane.exec("a")
    void lane.exec("b")
    void lane.exec("c")

    expect(world.runCommand).toHaveBeenCalledTimes(2)

    const resolve = deferred[0] as (r: { statusCode: number; statusMessage: string }) => void
    resolve({ statusCode: 0, statusMessage: "a" })
    await vi.waitFor(() => { expect(world.runCommand).toHaveBeenCalledTimes(3) })
  })

  it("createLane throws when not enough slots (need >=1 for public)", () => {
    const { gl } = makeGame(3)
    gl.createLane(2)
    expect(() => gl.createLane()).toThrow("createLane")
    expect(() => gl.createLane(1)).toThrow("createLane")
  })

  it("Close before WorldInitialize rejects queued commands", async () => {
    const { gl, server } = makeGame(100)

    const p = gl.exec("say hi")
    server.emit(SE.Close)
    await expect(p).rejects.toThrow("GameLoop destroyed")
  })

  it("Close after WorldInitialize lets in-flight commands complete", async () => {
    const { gl, server } = makeGame(100)
    const { world, deferred } = makeWorld()
    server.emit(SE.WorldInitialize, { world })

    const p = gl.exec("say hi")
    server.emit(SE.Close)

    const resolve = deferred[0] as (r: { statusCode: number; statusMessage: string }) => void
    resolve({ statusCode: 0, statusMessage: "ok" })
    const r = await p
    expect(r.statusCode).toBe(0)
  })

  it("exec after destroy does not throw (queues silently)", () => {
    const { gl, server } = makeGame(100)
    const { world } = makeWorld()
    server.emit(SE.WorldInitialize, { world })
    server.emit(SE.Close)

    expect(() => gl.exec("say hi")).not.toThrow()
  })
})
