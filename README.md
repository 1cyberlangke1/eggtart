# EggTart 🥚

MCBE WebSocket 工具集 — 区域管理、建造、查询、MCP 服务

## 功能

- **剑追踪选点** — 持下界合金剑右键依次选点1→点2→创建区域
- **木剑删除** — 持木剑指向已有区域，右键直接删除
- **区域粒子框** — 实时粒子框可视化区域边界
- **含水检测** — 检测方块是否含水
- **扫描到文件** — 三阶段并发扫描区域方块数据，输出 JSON
- **JS 脚本批量建造** — VM 沙箱执行 JS，用 `setBlock`/`fillBlock` 相对坐标放置方块
- **MCP 集成** — 7 个工具供 LLM 直接操控游戏

## 快速开始

```bash
npm install
```

编辑 `config.json`：

```json
{
  "playerName": "你的游戏名",
  "port": "8000"
}
```

启动：

```bash
npm run build
npm start
```

游戏内执行 `/wsserver localhost:8000` 连接，控制台出现 "EggTart 已就绪" 即成功。

## MCP 集成

EggTart 内置 MCP 服务器（stdio 传输），注册了 7 个工具：

| 工具 | 说明 |
|------|------|
| `mcbe_create_region_at` | 框选坐标并创建区域 |
| `mcbe_list_regions` | 列出所有区域及大小 |
| `mcbe_get_region` | 查询指定区域详情 |
| `mcbe_delete_region` | 删除区域 |
| `mcbe_scan_region` | 扫描区域方块到文件（性能警告） |
| `mcbe_run_command` | 执行 MCBE 命令并返回输出 |
| `mcbe_run_script` | 在区域内执行 JS 建造脚本 |
| `mcbe_get_player_info` | 获取玩家位置、朝向、维度 |

### opencode.json 配置

项目级（`opencode.json`，放在 EggTart 目录下）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "eggtart": {
      "type": "local",
      "command": ["node", "dist/main.js"]
    }
  }
}
```

全局配置（`~/.config/opencode/opencode.json`）需写绝对路径：

```json
{
  "mcp": {
    "eggtart": {
      "type": "local",
      "command": ["node", "<替换为 EggTart 的绝对路径>/dist/main.js"]
    }
  }
}
```

其他 MCP 客户端（Claude Code 等）格式类似：

```json
{
  "mcpServers": {
    "eggtart": {
      "command": "node",
      "args": ["<替换为 EggTart 的绝对路径>/dist/main.js"]
    }
  }
}
```



## 游戏内操作

| 操作 | 效果 |
|------|------|
| 持下界合金剑右键方块 | 选点1 → 选点2 → 创建区域 |
| 切换快捷栏再切回 | 状态保持，继续选点 |
| 持木剑指向区域右键 | 删除指向的区域 |
| `!help` | 查看聊天命令列表 |
| `!setp1/!setp2` | 手动设置选点 |
| `!block` | 查询方块信息 |
| `!waterlog` | 检测方块含水 |
| `!scan` | 扫描区域到文件 |
| `!ticking` | 管理常加载区块 |

## 架构

```
config.json → Server → GameLoop(限速100) → WorldInitialize
                         ↓
                    MCP Server (stdio)
```

- **GameLoop** 队列限速 100 并发，超过时自动排队
- **Lane** 系统为粒子、区域框等高频率操作使用独立通道
- **路径解析** 自动适配 `tsx` 开发模式和 `node dist/` 编译模式
- **语言数据** 按检测到的游戏语言懒加载，不预读全部
- **MCP 服务** 和 WS 服务在同进程中启动，通过 `GameLoop.instance` 全局访问

## 开发

```bash
npm run dev      # tsx watch 热重载（开发用）
npm run build    # 编译到 dist/
npm run lint     # ESLint 检查
npm run test     # Vitest 测试
```

提交前需保证 `npm run lint` 和 `npm run build` 零错误。

## 致谢

- [socket-be](https://github.com/tutinoko2048/SocketBE) (MIT) — MCBE WebSocket 通信库

## 许可证

MIT © 1cyberlangke1
