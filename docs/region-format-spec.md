# MCBE 区域方块表示格式 v1

混合格式：调色板 + Fill 盒子 + RLE（游程编码）+ 最优扫描方向。

## 设计目标

- **无损**：完整记录区域内每个方块的位置、ID、状态
- **紧凑**：token 数最小，适合 LLM 微调
- **多态编码**：大片均匀区域用 fill 盒子，复杂区域用 RLE 兜底
- **状态完整**：支持所有方块属性值（`facing=`, `half=`, `snowy=` 等）

## 格式概览

```
```region
0,4,0~9,13,9
P|0|1|2|stone|grass_block[snowy=false]|dirt
S|x,z,y
F|1:0,4,0,9,4,9
F|0:1,5,1,8,12,8
R|1:50 0:10
```
```

## 字段定义

### Line 1：区域边界

```
minX,minY,minZ~maxX,maxY,maxZ
```

- `~` 分隔最小 / 最大坐标
- 坐标值不包括结束边界（半开区间 `[min, max)`）
- 体积 = `(maxX-minX) * (maxY-minY) * (maxZ-minZ)`

### Line 2：调色板（Palette）

```
P|0|1|2|stone|grass_block[snowy=false]|dirt
```

- `P|` 固定前缀
- `|` 分隔，**奇数为索引**，**偶数为方块完整 ID + 状态**
- 索引 **0 强制为空气**，但省略 `0|minecraft:air`——空气必然存在且出现最频繁
- 其余索引按出现**频率降序**排列（高频方块索引小 = token 短）
- 方块 ID 省略 `minecraft:` 前缀（解析时自动补全）
- 状态属性省略 `key=value` 表示取默认值

### Line 3：扫描方向

```
S|x,z,y
```

或简写：

```
S|xzy
```

三字母分别对应快轴 / 中轴 / 慢轴。

决定 RLE 数据的扫描顺序。沿快轴遍历最快，相同方块连续段最长。

大结构自动选最优方向：

| 结构类型 | 快轴 | 中轴 | 慢轴 | 理由 |
|----------|:----:|:----:|:----:|------|
| 平地 / 房间 | x | z | y | 水平大片连续，y 变化最少 |
| 塔楼 / 树 / 烟囱 | y | x | z | 垂直方向连续段最长 |
| 隧道 / 长墙 | z | y | x | 沿隧道方向重复 |
| 混合 / 未知 | x | y | z | 折中 |

### Line 4+：Fill 盒子

```
F|<palette_idx>:<minX,minY,minZ,maxX,maxY,maxZ>
```

- `F|` 前缀
- 格式：`调色板索引:最小坐标~最大坐标`
- 盒子区域内所有方块必须是同一类型
- 盒子之间不重叠（分解算法保证）
- 解析时盒子按出现顺序应用，后出现的覆盖先出现的

### RLE 数据

```
R|<idx1>:<count1> <idx2>:<count2> ...
```

- `R|` 前缀
- `idx:count` 空格分隔，`idx` 为调色板索引，`count` 为连续数量
- 一行放不下则多行，每行独立前缀 `R|`
- 总方块数 = 各段 count 之和 = 区域体积 - 所有 fill 覆盖体积

## 编码算法（数据生成端）

### 步骤 1：数据准备

输入：三维数组 `blocks[x][y][z]` → 完整方块 ID + 状态字符串

### 步骤 2：构建调色板

1. 统计各方块出现频率
2. 索引 0 = 空气（隐式），其余按频率降序编号
3. 输出 `P|` 行

### 步骤 3：贪心 Fill 盒子分解

实现（基于 Pitkäkangas 2025 验证的贪心策略）：

```
function decompose(l):
  boxes = []
  visited = [false] * size(l)
  
  while true:
    找到 visited == false 的位置 (x,y,z)
    从该点向 +x、+y、+z 三方向贪心扩张到最大同色盒子
    
    cost_box = evaluateTokenCost(box)     // 固定约 18 token
    cost_rle = simulateRleTokenCost(box)   // 模拟这些方块按 x-major RLE 的 token
    
    if cost_box < cost_rle:
      boxes.push(box)
      mark visited(box)
    else:
      break   // 剩余的交给 RLE

  return boxes, unvisited
```

**token 收益评估：**

```
cost_box  = len("F|idx:x1,y1,z1,x2,y2,z2")  // ~18 字符
cost_rle  = sum(len(f"{idx}:{n} ") for each segment under S|xzy scan)

if cost_box < cost_rle → 采纳盒子
else → 留给 RLE
```

### 步骤 4：选择最优扫描方向

对剩余未覆盖方块，枚举 6 种扫描顺序（xyz、xzy、yxz、yzx、zxy、zyx），选 RLE 段数最少的。

### 步骤 5：输出 RLE

按最优方向扫过所有剩余未访问方块，连续同索引方块合并。

## 解码算法（读取端）

```
1. 解析 R 行 → 区域边界
2. 解析 P 行 → 索引→方块映射表
3. 解析 S 行 → 扫描方向（仅用于 RLE 部分）
4. 解析所有 F 行 → 按坐标填入方块
5. 解析所有 R 行 → 按扫描方向逐段填入
```

## Token 效率估测

| 场景 | 原始体积 | Fill 数 | RLE 段数 | 总 token |
|------|:--------:|:-------:|:--------:|:--------:|
| 10³ 空区域 | 1000 | 1 | 0 | ~50 |
| 10³ 中空房间 | 1000 | 4-6 | 0-5 | ~100 |
| 10³ 复杂雕塑 | 1000 | 0-3 | 5-50 | ~150 |
| 50³ 空岛 | 125000 | 2-5 | 3-20 | ~200 |
| 3×3×7 树 | 63 | 1-2 | 5-15 | ~80 |

## 参考

- Pitkäkangas, V. (2025). *Against Expectations: A Simple Greedy Heuristic Outperforms Advanced Methods in Bitmap Decomposition*. Electronics, 14(13), 2615.
- Höschl, C. & Flusser, J. (2019). *Close-to-optimal algorithm for rectangular decomposition of 3D shapes*. Kybernetika, 55(5), 755-781.
- Cruz-Matías, I. & Ayala, D. (2017). *Compact Union of Disjoint Boxes: An Efficient Decomposition Model for Binary Volumes*. Computación y Sistemas, 21(2).
- Mikola Lysenko. *Meshing in a Minecraft Game* (2012) / *rectangle-decomposition* (npm).
