import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { Server, ServerEvent } from "socket-be";
import { createServer } from "net";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DATA_DIR = join(ROOT, "data");
const CONFIG_PATH = join(SCRIPT_DIR, "config.json");

const config: { commands: string[] } = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { commands: string[] };

function parsePort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx >= 0) {
    const arg = process.argv[idx + 1];
    if (arg) {
      const v = parseInt(arg);
      if (!isNaN(v)) return v;
    }
  }
  return 8000;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object" && "port" in addr) {
        srv.close(() => { resolve(addr.port); });
      } else {
        srv.close();
        reject(new Error("无法获取空闲端口"));
      }
    });
    srv.on("error", reject);
  });
}

function searchMcbeLangFiles(): string[] {
  const candidates: string[] = [];
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const winApps = join(programFiles, "WindowsApps");
  if (existsSync(winApps)) {
    try {
      for (const entry of readdirSync(winApps)) {
        if (entry.startsWith("Microsoft.MinecraftUWP_")) {
          const p = join(winApps, entry, "data", "resource_packs", "vanilla", "texts");
          if (existsSync(p)) candidates.push(p);
        }
      }
    } catch (e: unknown) {
      console.error(`  [错误] 无法读取 ${winApps}: ${(e as Error).message}`);
    }
  }
  const localAppData = process.env.LOCALAPPDATA || "";
  if (localAppData) {
    const packages = join(localAppData, "Packages");
    if (existsSync(packages)) {
      try {
        for (const entry of readdirSync(packages)) {
          if (entry.startsWith("Microsoft.MinecraftUWP_")) {
            const base = join(packages, entry, "LocalState");
            const tp = join(base, "treatments", "treatment_packs2");
            if (existsSync(tp)) {
              for (const pack of readdirSync(tp)) {
                const tpTexts = join(tp, pack, "texts");
                if (existsSync(tpTexts)) candidates.push(tpTexts);
              }
            }
          }
        }
      } catch (e: unknown) {
        console.error(`  [错误] 无法读取 ${packages}: ${(e as Error).message}`);
      }
    }
  }
  const unique: string[] = [];
  for (const c of candidates) {
    if (!unique.some(u => u.toLowerCase() === c.toLowerCase())) unique.push(c);
  }
  return unique;
}

function findLangFiles(dirs: string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".lang")) continue;
      const full = join(dir, entry);
      if (!files.has(entry)) files.set(entry, full);
    }
  }
  return files;
}

function escReDot(key: string): string {
  return key.replace(/\./g, "\\.");
}

function extractTileNameCount(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (/^tile\.(.+)\.name=.+/.test(line)) n++;
  }
  return n;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (): number[] => Array.from({ length: n + 1 }, (): number => 0));
  for (let i = 0; i <= m; i++) (dp[i] as number[])[0] = i;
  const firstRow = dp[0] as number[];
  for (let j = 0; j <= n; j++) firstRow[j] = j;
  for (let i = 1; i <= m; i++) {
    const row = dp[i] as number[];
    const prevRow = dp[i - 1] as number[];
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1]
        ? (prevRow[j - 1] as number)
        : Math.min(prevRow[j - 1] as number, prevRow[j] as number, row[j - 1] as number) + 1;
    }
  }
  return (dp[m] as number[])[n] as number;
}

async function main() {
  const port = parsePort();

  console.log("搜索 MC 语言文件...");
  const dirs = searchMcbeLangFiles();
  for (const d of dirs) console.log(`  ${d}`);
  const langFiles = findLangFiles(dirs);
  console.log(`找到 ${langFiles.size} 个 .lang`);

  const actualPort = port === 0 ? await findFreePort() : port;

  await new Promise<void>((resolveMain) => {
    let server: Server;
    try {
      server = new Server({ port: actualPort });
    } catch (e: unknown) {
      console.error(`[错误] 无法监听端口 ${actualPort}: ${(e as Error).message}`);
      resolveMain();
      return;
    }

    server.on(ServerEvent.Open, () => {
      console.log(`socket-be 监听端口: ${actualPort}`);
      console.log(`等待 MC 连接 ws://localhost:${actualPort} ...`);
    });

    server.on(ServerEvent.WorldInitialize, async (ev) => {
      try {
        const raw = await ev.world.queryData("block") as Array<{ name: string; id: string }>;
        console.log(`连 MC ✅ (queryData: ${raw.length} 方块)`);

        const nameEntries = new Map<string, string[]>();
        for (const b of raw) {
          const arr = nameEntries.get(b.name);
          if (arr) {
            if (!arr.includes(b.id)) arr.push(b.id);
          } else {
            nameEntries.set(b.name, [b.id]);
          }
        }
        const engNameToId = new Map<string, string>();
        for (const [name, ids] of nameEntries) {
          const first = ids[0];
          if (!first) continue;
          if (ids.length === 1) {
            engNameToId.set(name, first);
          } else {
            const slug = slugify(name);
            let best = first;
            let bestDist = levenshtein(slug, first);
            for (let i = 1; i < ids.length; i++) {
              const candidate = ids[i];
              if (!candidate) continue;
              const dist = levenshtein(slug, candidate);
              if (dist < bestDist) {
                bestDist = dist;
                best = candidate;
              }
            }
            engNameToId.set(name, best);
          }
        }

        const enUsPath = langFiles.get("en_US.lang");
        if (!enUsPath) {
          console.error("[错误] 找不到 en_US.lang");
          process.exit(1);
        }
        const enUsText = readFileSync(enUsPath, "utf-8");
        const langKeyToEn = new Map<string, string>();
        for (const line of enUsText.split("\n")) {
          const m = line.match(/^tile\.(.+)\.name=(.+)/);
          if (m) {
            const k = m[1];
            const v = m[2];
            if (k && v) langKeyToEn.set(k, v.trim());
          }
        }

        for (const [name, srcPath] of langFiles) {
          const lang = name.replace(/\.lang$/, "");
          let text: string;
          try {
            text = readFileSync(srcPath, "utf-8");
          } catch (e: unknown) {
            console.error(`  [${lang}] [错误] 无法读取文件: ${srcPath} - ${(e as Error).message}`);
            continue;
          }
          const outDir = join(DATA_DIR, lang);
          mkdirSync(outDir, { recursive: true });

          const commands: Record<string, string> = {};
          for (const key of config.commands) {
            const m = text.match(new RegExp("^" + escReDot(key) + "=(.+)", "m"));
            if (m) {
              const val = m[1];
              if (val) commands[key] = val.trim();
            }
          }
          writeFileSync(join(outDir, "commands.json"), JSON.stringify(commands, null, 2));

          const blocks: Record<string, string> = {};
          const misses: string[] = [];
          for (const line of text.split("\n")) {
            const m = line.match(/^tile\.(.+)\.name=(.+)/);
            if (!m) continue;
            const langKey = m[1];
            const displayNameRaw = m[2];
            if (!langKey || !displayNameRaw) continue;
            const displayName = displayNameRaw.trim();
            const enName = langKeyToEn.get(langKey);
            if (!enName) {
              if (misses.length < 5) misses.push(`${langKey}(langKeyToEn 无此键)`);
              continue;
            }
            const gameId = engNameToId.get(enName);
            if (!gameId) {
              if (misses.length < 5) misses.push(`${langKey}→"${enName}"(engNameToId 无此名)`);
              continue;
            }
            blocks[displayName] = gameId;
          }
          writeFileSync(join(outDir, "blocks.json"), JSON.stringify(blocks, null, 2));

          const cmdTotal = config.commands.length;
          const cmdOk = Object.keys(commands).length;
          const blkTotal = extractTileNameCount(text);
          const blkOk = Object.keys(blocks).length;

          console.log(`[${lang}] ${srcPath}  commands: ${cmdOk}/${cmdTotal}  blocks: ${blkOk}/${blkTotal}`);
          if (misses.length > 0) console.log(`  miss: ${misses.slice(0,5).join(", ")}`);
        }

        console.log(`\n完成 (${langFiles.size} 语言, 输出: ${DATA_DIR}/{lang}/commands.json + blocks.json)`);
        process.exit(0);
      } catch (e: unknown) {
        console.error(`[错误] WorldInitialize 处理失败: ${(e as Error).message}`);
        process.exit(1);
      }
    });
  });
}

void main();
