# EggTart 项目状态

## 目标

MCBE WebSocket 工具集。通过 socket-be 连接游戏，用 GameLoop 限速 100 并发，
CmdParser 解析本地化命令输出。方块查询、含水检测、区域管理、剑追踪选点+创建、
木剑删除区域、扫描到文件。

## 代码结构（src/）

```
src/
├── main.ts                    ← 入口：config → Server → GameLoop → 欢迎
├── utils/
│   ├── core/
│   │   └── game-loop.ts       ← 队列限速 100 + Lane(slots) + 公共池
│   ├── world/
│   │   ├── sword-track.ts     ← 剑追踪 p1→p2→create 三态
│   │   ├── region-deleter.ts  ← 木剑删除区域
│   │   ├── region.ts          ← 区域管理 + 粒子框
│   │   ├── scanner.ts         ← 扫描三阶段并发
│   │   ├── waterlog.ts        ← 含水检测
│   │   ├── block-utils.ts     ← getBlock/States
│   │   └── ticking-area.ts    ← 常加载区块
│   ├── chat/
│   │   └── chat-handler.ts    ← 命令注册/派发/help
│   ├── config/
│   │   ├── config.ts          ← 读 config.json
│   │   └── port.ts            ← parsePort + findFreePort
│   ├── lang/
│   │   └── lang-detect.ts     ← 预索引 footer → 懒加载匹配语言
│   └── reader/
│       └── cmd-parser.ts      ← 命令输出解析
├── scripts/                   ← 一次性脚本
└── data/                      ← 预编译（29语 blocks.json, block_state_map.json）
```

## 运行时架构

```
启动 → loadConfig → new Server → new GameLoop(server, 100)
  → GameLoop.instance = this
  → Open: log 启动端口
  → WorldInitialize (async):
      1. log.success("EggTart 已就绪", { game: true })
      2. exec("help") → detectLanguage(helpMsg)
         失败 → 原始输出 + log.error + exit
         成功 → gl.parser, gl.lang
      3. 读 data/<lang>/blocks.json → gl.blocks
      4. 读 data/block_state_map.json → gl.blockStateMap
      5. tickingArea → tickingEnsure/fillChunk → gl.tickingReady
      6. 读 waterloggable_blocks.json → gl.waterloggableBlocks
      7. regionManager.createLanes()
      8. swordTracker.startTimers()  (下界合金剑选点p1→p2→create)
      9. regionDeleter.startTimers() (木剑删除区域)
  → Close: destroy()
```

## 关键约定

- GameLoop.instance 做全局访问点，模块不传参直接拿
- Logger 默认发到游戏（game: true），{ game: false } 关掉
- 游戏输出格式: `§<前缀色><模块名> §r消息内容`
- 控制台输出: ANSI 色 `[模块名]` + 无色消息
- 数据只加载检测到的语言，不预读全部
- config.json 在项目根目录，playerName 必填，port 默认 8000

## 纪律

- **提交前必须跑 eslint**：`npx eslint src/`，零错误才提交
- **提交前必须跑 tsc**：`npx tsc --noEmit`，零错误才提交
- **禁止 `any`**、**禁止 `!` non-null assertion**
- **先确认再改**：socket-be 字段、游戏机制，不猜

---

# MCBE WebSocket 事件发现

## 本项目的发现（非 socket-be 事件）

通过 WS subscribe 手动验证的 MCBE WebSocket 事件：

| 事件名 | 验证日期 | 触发方式 |
|--------|----------|----------|
| `PlayerDied` | 2026-07-03 | 玩家死亡 |
| `ItemDropped` | 2026-07-03 | 按 Q 丢弃物品 |
| `ItemUsed` | 2026-07-03 | 右键使用物品 |
| `MobKilled` | 2026-07-03 | 杀死生物 |

## 方法

1. 从 `libminecraftpe.so` 中提取所有 PascalCase 字符串（12036 个）
2. 按长度/元音/类名前缀过滤，逐行人工筛选
3. 对候选写 WS subscribe 脚本，开游戏 `/wsserver localhost:8000` 连接
4. 触发对应游戏行为，看 MC 是否推送 event

## 来源

- 初始候选来自 `libminecraftpe.so`（v1.26.32.2，arm64-v8a）
- socket-be 库提供了 17 个已知事件的基准参考
- 本项目在 socket-be 之外确认了 4 个新事件

## WS 命令格式

```json
{
  "header": {
    "version": 1,
    "requestId": "<UUID>",
    "messagePurpose": "commandRequest",
    "messageType": "commandRequest"
  },
  "body": {
    "version": 1,
    "commandLine": "<命令>",
    "origin": { "type": "player" }
  }
}
```

**注意：** 字段名是 `commandLine` 不是 `command`，body 必须有 `version: 1`。

## WS 事件订阅格式

```json
{
  "header": {
    "version": 1,
    "requestId": "<UUID>",
    "messagePurpose": "subscribe",
    "messageType": "commandRequest"
  },
  "body": { "eventName": "<事件名>" }
}
```

## WS 加密握手

MCBE 支持可选的 WS 加密（通过 `EnableEncryption` 事件触发）。

**流程：**

1. MC 推送 `EnableEncryption` 事件 → 通知 WS 服务器将启用加密
2. WS 服务器生成 ECDH 密钥对（`prime256v1` 曲线）
3. WS 服务器发 `ws:encryptionRequest`：

```json
{
  "header": {
    "version": 1,
    "requestId": "<UUID>",
    "messagePurpose": "ws:encryptionRequest"
  },
  "body": {
    "mode": "cfb8",
    "publicKey": "<ECDH 公钥，base64>",
    "salt": "<16 字节随机盐，base64>"
  }
}
```

4. MC 回 `ws:encryptionResponse`：

```json
{
  "header": {
    "version": 1,
    "requestId": "<UUID>",
    "messagePurpose": "ws:encryptionResponse"
  },
  "body": {
    "publicKey": "<MC 的 ECDH 公钥>"
  }
}
```

5. 双方通过 ECDH 计算共享密钥，然后用 `SHA-256(salt + 共享密钥)` 派生出 AES-256 密钥
6. 之后所有 WS 消息用 **AES-256-CFB8** 加密传输

**支持的模式：** `cfb8`、`cfb`、`cfb128`

**加密类：** socket-be 的 `Encryption` 类封装了握手 + 加解密，内部使用 Node.js 的 `crypto.createECDH("prime256v1")` 和 `crypto.createCipheriv("aes-256-ecb", ...)` 实现 CFB8 模式。

---

## 完整事件参考

所有通过 WS subscribe 确认可用的游戏事件。

### 事件列表

| 事件名 | 来源 | 触发方式 |
|--------|------|----------|
| `PlayerJoin` | socket-be | 玩家加入世界 |
| `PlayerLeave` | socket-be | 玩家离开世界 |
| `PlayerMessage` | socket-be | 玩家发聊天消息 |
| `PlayerDied` | **本项目发现** | 玩家死亡 |
| `PlayerBounced` | socket-be | 玩家弹跳 |
| `PlayerTeleported` | socket-be | 玩家传送 |
| `PlayerTransform` | socket-be | 玩家变换 |
| `PlayerTravelled` | socket-be | 玩家旅行 |
| `BlockBroken` | socket-be | 方块被破坏 |
| `BlockPlaced` | socket-be | 方块被放置 |
| `ItemAcquired` | socket-be | 获得物品 |
| `ItemCrafted` | socket-be | 合成物品 |
| `ItemDropped` | **本项目发现** | 丢弃物品（按 Q） |
| `ItemEquipped` | socket-be | 装备物品 |
| `ItemInteracted` | socket-be | 与物品交互 |
| `ItemSmelted` | socket-be | 熔炼物品 |
| `ItemTraded` | socket-be | 交易物品 |
| `ItemUsed` | **本项目发现** | 使用物品（右键） |
| `MobInteracted` | socket-be | 与生物交互 |
| `MobKilled` | **本项目发现** | 击杀生物 |
| `TargetBlockHit` | socket-be | 击中目标方块 |
| `ScreenChanged` | socket-be | 界面切换 |

### 其他 socket-be ServerEvent（非游戏事件）

| 事件名 | 说明 |
|--------|------|
| `Open` | WS 连接打开 |
| `Close` | WS 连接关闭 |
| `WorldAdd` | 世界被添加 |
| `WorldRemove` | 世界被移除 |
| `WorldInitialize` | 世界初始化 |
| `PlayerLoad` | 玩家数据加载 |
| `PlayerChat` | 聊天事件 |
| `PlayerTitle` | 标题事件 |
| `EnableEncryption` | 加密启用 |

共 **30 个**可用事件，其中 **4 个**为本项目发现（非 socket-be 库已有事件）。

---

## WS 命令队列限制

MCBE 服务端对 WS 命令有硬性并发限制：

| 属性 | 值 |
|------|:---:|
| 最大并发 pending 命令 | **100** |
| 超限状态码 | `-2147418109` (`TooManyPendingRequests`) |
| 超限消息 | "Too many commands have been requested, wait for one to be done" |
| 来源 | [sanand0/minecraft-websocket](https://deepwiki.com/sanand0/minecraft-websocket/4.5-stage-5:-command-queue-management) 实测逆向 |

当第 101 条命令在之前命令未响应时发出，MC 拒绝并返回上述错误。
socket-be 不内置队列管理，上层需要自行控制并发量。

### 社区标准解法：双队列 + 响应驱动

```
sendQueue: 待发送的命令
awaitedQueue: 已发送、等待响应的命令 (上限 80-100)

流程：
1. 所有命令先入 sendQueue
2. 每次收到 commandResponse：
   a. 从 awaitedQueue 移除已完成的命令
   b. 从 sendQueue 取 (100 - awaitedQueue.length) 条发出
3. 天然不超过 100 并发
```

### 备用的轻量解法：计数信号量

```ts
let pending = 0;
async function limitedRun(cmd: string) {
  while (pending >= 80) await new Promise(r => setTimeout(r, 10));
  pending++;
  return world.runCommand(cmd).finally(() => pending--);
}
```

不适合大量 fire-and-forget 粒子命令——信号量排队会阻塞链条。

## 纪律

- **提交前必须跑 eslint**：`npx eslint src/`，零错误才提交
- **禁止 `any`**、**禁止 `!` non-null assertion**
- 跑完 lint 再跑 `npx tsc --noEmit`，都通过才能提交

### 项目中触发此限制的场景

- `!setp1/!setp2` 区域框 → 一次递送 56-196 条粒子命令
- 粒子走 `world.runCommand(...).catch(() => {})` 每条都会注册一个 pending
- 剑追踪 200ms 间隔的 tp + query 叠加粒子 → 峰值超过 100
- setTimeout 散布（30ms 间隔）能缓解但不能完全避免概率触发
