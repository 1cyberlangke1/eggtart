import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { Server, ServerEvent } from "socket-be";
import { createServer } from "net";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DATA_DIR = join(ROOT, "data");
const CONFIG_PATH = join(SCRIPT_DIR, "config.json");

interface Config {
  commands: string[];
  stateBlacklist: string[];
  wikiUrl: string;
}

const config: Config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Config;

const blacklist = new Set(config.stateBlacklist);

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

const BOOTHS: [number, number, number][] = (() => {
  const r: [number, number, number][] = [];
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
    r.push([x * 4, 0, z * 4]);
    r.push([x * 4, 4, z * 4]);
  }
  return r;
})();

interface StateInfo {
  first: string;
  values: string;
}

function buildPattern(template: string): RegExp {
  const escaped = template
    .replace(/%\d+\$[sd]/g, "%%CAP%%")
    .replace(/[.+*?^${}()|[\]\\]/g, "\\$&")
    .replace(/%%CAP%%/g, ".+?");
  return new RegExp("^" + escaped + "$");
}

function parseValue(firstTd: string): string | null {
  const intM = firstTd.match(/Integer\s*\(?\s*<code>(\d+)<\/code>\s*to\s*<code>\d+<\/code>/i);
  if (intM && intM[1]) return intM[1];
  if (/Boolean/i.test(firstTd)) return "true";
  const li = [...firstTd.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)];
  if (li.length && li[0] && li[0][1]) return li[0][1];
  const code = [...firstTd.matchAll(/<code>([^<]+)<\/code>/g)];
  if (code.length && code[0] && code[0][1]) return code[0][1];
  return null;
}

function mergeValues(allValues: Set<string>): string {
  const vals = [...allValues];
  if (vals.length === 1) return vals[0] as string;
  const ints = vals.filter(v => /^\d+-\d+$/.test(v));
  if (ints.length === vals.length) {
    const mins = ints.map(v => parseInt(v.split("-")[0] as string));
    const maxs = ints.map(v => parseInt(v.split("-")[1] as string));
    return `${Math.min(...mins)}-${Math.max(...maxs)}`;
  }
  return vals.join(",");
}

function parseWikiStates(html: string): Map<string, StateInfo> {
  const body = html.substring(html.indexOf('id="Block_states'));
  const depIdx = body.indexOf('Deprecated_2');

  const matches = [...body.matchAll(
    /<div class="mw-heading mw-heading[34]"><h[34] id="[^"]*">([^<]+)<\/h[34]>[\s\S]*?<\/div>([\s\S]*?)(?=<div class="mw-heading mw-heading[234]|$)/g
  )];

  const active = new Map<string, StateInfo>();
  const deprecated = new Map<string, StateInfo>();

  for (const match of matches) {
    const heading = match[1] ?? "";
    const content = match[2] ?? "";
    const st = heading.trim();
    if (!st || !content) continue;

    const tds = [...content.matchAll(/<td>([\s\S]*?)<\/td>/g)]
      .map(m => (m[1] ?? "").trim())
      .filter(Boolean);
    if (tds.length < 1) continue;

    const allValues = new Set<string>();
    for (let i = 0; i < tds.length; i += 2) {
      const valTd = tds[i];
      if (!valTd) continue;

      const intM = valTd.match(/Integer\s*\(?\s*<code>(\d+)<\/code>\s*to\s*<code>(\d+)<\/code>/i);
      if (intM && intM[1] && intM[2]) {
        allValues.add(`${parseInt(intM[1])}-${parseInt(intM[2])}`);
        continue;
      }
      if (/Boolean/i.test(valTd)) {
        allValues.add("true,false");
        continue;
      }
      const liVals = [...valTd.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)]
        .map(x => x[1] as string);
      if (liVals.length) {
        allValues.add(liVals.join(","));
        continue;
      }
      const codeVals = [...valTd.matchAll(/<code>([^<]+)<\/code>/g)]
        .map(x => x[1] as string);
      if (codeVals.length) {
        allValues.add(codeVals.join(","));
      }
    }

    if (allValues.size === 0) continue;
    const merged = mergeValues(allValues);

    const firstTd = tds[0] as string;
    const first = parseValue(firstTd);
    if (!first) continue;

    const isDep = depIdx >= 0 && match.index >= depIdx;
    if (isDep) {
      deprecated.set(st, { first, values: merged });
    } else {
      console.log(`  [${st}] → values=${merged} first=${first}`);
      active.set(st, { first, values: merged });
    }
  }

  console.log(`[抓取] 共 ${matches.length} 个状态`);
  console.log(`[抓取] 活跃: ${active.size}, 废弃: ${deprecated.size}`);
  if (deprecated.size > 0) {
    console.log(`[废弃] ${[...deprecated.keys()].join(", ")}`);
  }
  return active;
}

function detectLanguage(helpMsg: string): { lang: string; cmds: Record<string, string> } | null {
  if (!existsSync(DATA_DIR)) return null;
  for (const langDir of readdirSync(DATA_DIR)) {
    const cp = join(DATA_DIR, langDir, "commands.json");
    if (!existsSync(cp)) continue;
    try {
      const c: Record<string, string> = JSON.parse(readFileSync(cp, "utf-8")) as Record<string, string>;
      const footer = c["commands.help.footer"];
      if (footer && helpMsg.includes(footer)) {
        return { lang: langDir, cmds: c };
      }
    } catch { /* skip this lang dir */ }
  }
  return null;
}

async function main() {
  const port = parsePort();
  const actualPort = port === 0 ? await findFreePort() : port;

  console.log("抓取 Wiki 状态列表...");
  let html: string;
  try {
    const resp = await fetch(config.wikiUrl);
    html = await resp.text();
    console.log(`[Wiki] ${config.wikiUrl} (${html.length} bytes)`);
    if (html.includes("Enable JavaScript and cookies") || !html.includes("Block_states")) {
      console.error("[错误] 被 Cloudflare 拦截，无法获取 Wiki 页面");
      process.exit(1);
    }
  } catch (e: unknown) {
    console.error(`[错误] 抓取 Wiki 失败: ${(e as Error).message}`);
    process.exit(1);
  }

  const states = parseWikiStates(html);
  if (states.size === 0) {
    console.error("[错误] 未解析到任何状态");
    process.exit(1);
  }

  console.log(`\n黑名单: ${config.stateBlacklist.join(", ")}`);
  for (const st of config.stateBlacklist) {
    if (states.has(st)) console.log(`  [跳过] ${st}（黑名单）`);
    else console.log(`  [跳过] ${st}（黑名单，但 Wiki 无此状态）`);
  }

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
      console.log(`\nsocket-be 监听端口: ${actualPort}`);
      console.log(`等待 MC 连接 ws://localhost:${actualPort} ...`);
    });

    server.on(ServerEvent.WorldInitialize, async (ev) => {
      try {
        const world = ev.world;

        console.log("\n查询方块数据...");
        const raw = await world.queryData("block") as Array<{ name: string; id: string }>;
        const allIds = [...new Set(raw.map(b => b.id))].sort();
        console.log(`[queryData] ${allIds.length} 个方块`);

        console.log("\n检测游戏语言...");
        let cmdData: Record<string, string> | null = null;
        let activeLang = "en_US";
        try {
          const helpR = await world.runCommand("help");
          const helpMsg: string = helpR.statusMessage;
          const detected = detectLanguage(helpMsg);
          if (detected) {
            activeLang = detected.lang;
            cmdData = detected.cmds;
          }
        } catch { /* language detection failed, use defaults */ }

        if (!cmdData) {
          const cp = join(DATA_DIR, "en_US", "commands.json");
          if (existsSync(cp)) {
            cmdData = JSON.parse(readFileSync(cp, "utf-8")) as Record<string, string>;
          }
        }
        if (!cmdData) {
          console.error("[错误] 找不到 commands.json");
          process.exit(1);
        }
        console.log(`[语言] ${activeLang}`);

        const stateErrorRE = cmdData["commands.blockstate.stateError"]
          ? buildPattern(cmdData["commands.blockstate.stateError"]) : null;
        const invalidStateRE = cmdData["commands.blockstate.invalidState"]
          ? buildPattern(cmdData["commands.blockstate.invalidState"]) : null;
        const failedDataRE = cmdData["commands.testforblock.failed.data"]
          ? buildPattern(cmdData["commands.testforblock.failed.data"]) : null;

        console.log(`[正则] stateError: ${stateErrorRE?.source ?? "无"}`);
        console.log(`[正则] invalidState: ${invalidStateRE?.source ?? "无"}`);
        console.log(`[正则] failed.data: ${failedDataRE?.source ?? "无"}`);

        const chunkSize = Math.ceil(allIds.length / BOOTHS.length);
        const chunks: Array<{ pos: [number, number, number]; ids: string[] }> = BOOTHS.map((b, i) => ({
          pos: b,
          ids: allIds.slice(i * chunkSize, (i + 1) * chunkSize),
        }));

        const activeStates = [...states.entries()].filter(([name]) => !blacklist.has(name));

        const mapping: Record<string, string[]> = {};
        let totalTests = 0;
        let lastTitle = 0;
        const estimatedTotal = activeStates.length * allIds.length;
        console.log(`\n验证 ${activeStates.length} 个状态（跳过 ${states.size - activeStates.length} 个黑名单）...`);

        async function runBooth(pos: [number, number, number], ids: string[]) {
          const [bx, by, bz] = pos;
          for (const blockId of ids) {
            await world.runCommand(`setblock ${bx} ${by - 1} ${bz} glass replace`);
            await world.runCommand(`setblock ${bx} ${by + 1} ${bz} glass replace`);
            for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
              await world.runCommand(`setblock ${bx + dx} ${by} ${bz + dz} glass replace`);
            }
            await world.runCommand(`setblock ${bx} ${by} ${bz} air replace`);

            const sr = await world.runCommand(`setblock ${bx} ${by} ${bz} ${blockId}`);
            const srCode: number = sr.statusCode;
            if (srCode !== 0) continue;

            const found: string[] = [];
            for (const [stateName, info] of activeStates) {
              totalTests++;
              const q = /^\d+$|^true$|^false$/i.test(info.first) ? info.first : `"${info.first}"`;
              const tr = await world.runCommand(
                `testforblock ${bx} ${by} ${bz} ${blockId} ["${stateName}"=${q}]`
              );
              const trCode: number = tr.statusCode;
              if (trCode === 0) {
                const arr = mapping[stateName] ?? [];
                arr.push(blockId);
                mapping[stateName] = arr;
                found.push(stateName);
              } else if (failedDataRE && failedDataRE.test(tr.statusMessage)) {
                const arr = mapping[stateName] ?? [];
                arr.push(blockId);
                mapping[stateName] = arr;
                found.push(stateName);
              }
            }

            const now = Date.now();
            if (now - lastTitle >= 1000) {
              lastTitle = now;
              const pct = Math.round(totalTests / estimatedTotal * 100);
              console.log(`[进度] ${totalTests}/${estimatedTotal} (${pct}%) | ${Object.keys(mapping).length} 状态命中`);
              await world.runCommand(
                `title @a actionbar §6验证 §a${pct}% §7| §f${totalTests}/${estimatedTotal}`
              );
            }
          }
        }

        await Promise.all(chunks.map(c => runBooth(c.pos, c.ids)));

        for (const pos of BOOTHS) {
          const [bx, by, bz] = pos;
          await world.runCommand(`setblock ${bx} ${by} ${bz} air replace`);
          for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
            await world.runCommand(`setblock ${bx + dx} ${by} ${bz + dz} air replace`);
          }
          await world.runCommand(`setblock ${bx} ${by - 1} ${bz} air replace`);
          await world.runCommand(`setblock ${bx} ${by + 1} ${bz} air replace`);
        }

        let removedCount = 0;
        for (const [stateName] of activeStates) {
          if (!mapping[stateName] || mapping[stateName].length === 0) {
            removedCount++;
            console.log(`[移除] ${stateName} — 0 个方块匹配`);
          } else {
            mapping[stateName] = [...new Set(mapping[stateName])].sort();
          }
        }

        const finalStates = Object.entries(mapping).filter(([, blocks]) => blocks.length > 0);
        const output: Record<string, { blocks: string[]; values: string; first: string }> = {};
        for (const [name, blocks] of finalStates) {
          const info = states.get(name);
          if (info) {
            output[name] = { blocks, values: info.values, first: info.first };
          }
        }

        const outDir = join(DATA_DIR, "block_state_map.json");
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(outDir, JSON.stringify(output, null, 2));

        const uniqBlocks = [...new Set(Object.values(output).flatMap(s => s.blocks))];

        console.log(`\n[完成] 总状态: ${states.size}`);
        console.log(`[完成] 黑名单: ${states.size - activeStates.length}`);
        console.log(`[完成] 空状态移除: ${removedCount}`);
        console.log(`[完成] 最终状态: ${finalStates.length}`);
        console.log(`[完成] 涉及方块: ${uniqBlocks.length}`);
        console.log(`[完成] testforblock 调用: ${totalTests}`);
        console.log(`[产出] ${outDir}`);

        process.exit(0);
      } catch (e: unknown) {
        console.error(`[错误] WorldInitialize 处理失败: ${(e as Error).message}`);
        process.exit(1);
      }
    });
  });
}

void main();
