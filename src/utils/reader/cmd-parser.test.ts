import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import { CmdParser } from "./cmd-parser.js";

const DATA_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "data");

interface Case {
  key: string;
  lang: string;
  tmpl: string;
  vals: string[];
  msg: string;
}

function buildMessage(tmpl: string, vals: string[]): string {
  let i = 0;
  return tmpl.replace(/%\d+\$[ds]/g, () => vals[i++] ?? "");
}

const langs = readdirSync(DATA_DIR)
  .filter(d => existsSync(join(DATA_DIR, d, "commands.json")))
  .sort();

const stateMapPath = join(DATA_DIR, "block_state_map.json");
const stateNames = existsSync(stateMapPath)
  ? Object.keys(JSON.parse(readFileSync(stateMapPath, "utf-8")) as Record<string, unknown>)
  : [];

function getLocalizedBlocks(lang: string): { names: string[]; ids: string[] } {
  const p = join(DATA_DIR, lang, "blocks.json");
  if (!existsSync(p)) return { names: [], ids: [] };
  const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
  return {
    names: Object.keys(raw),
    ids: [...new Set(Object.values(raw))],
  };
}

function rand<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)] as T;
}

function makeVals(key: string, lang: string, phCount: number): string[] {
  const blk = getLocalizedBlocks(lang);
  const vals: string[] = [];

  if (key === "commands.blockstate.stateError") {
    // %1$s=状态名, %2$s=含命名空间的game ID
    vals.push(rand(stateNames.length > 0 ? stateNames : blk.ids));
    vals.push("minecraft:" + rand(blk.ids));
  } else if (key === "commands.blockstate.invalidState") {
    // %1$s=状态名
    vals.push(rand(stateNames.length > 0 ? stateNames : blk.ids));
  } else if (key === "commands.testforblock.failed.tile") {
    // %1$d=x, %2$d=y, %3$d=z, %4$s=本地化名, %5$s=本地化名
    vals.push(...["0", "0", "0"]);
    vals.push(rand(blk.names), rand(blk.names));
  } else if (key === "commands.testforblock.failed.data" || key === "commands.testforblock.success") {
    // %1$d,%2$d,%3$d = 坐标
    vals.push(...["0", "0", "0"]);
  } else if (key === "commands.tickingarea.inuse" || key === "commands.tickingarea-add.failure") {
    // %1$d,%2$d = 数字
    vals.push(...["1", "10"].slice(0, phCount));
  } else if (key === "commands.tickingarea-add-bounds.success") {
    // %1$d,%2$d = 数字范围
    vals.push(...["0", "15"]);
  } else {
    // 兜底：不知道语义就塞数字
    for (let i = 0; i < phCount; i++) vals.push(String(Math.floor(Math.random() * 100)));
  }
  return vals;
}

const randomCases: Case[] = [];

for (const lang of langs) {
  const cmds = JSON.parse(
    readFileSync(join(DATA_DIR, lang, "commands.json"), "utf-8"),
  ) as Record<string, string>;
  for (const [key, tmpl] of Object.entries(cmds)) {
    const phCount = [...tmpl.matchAll(/%\d+\$[ds]/g)].length;
    for (let t = 0; t < 3; t++) {
      const vals = makeVals(key, lang, phCount);
      const msg = buildMessage(tmpl, vals);
      randomCases.push({ key, lang, tmpl, vals, msg });
    }
  }
}

describe("全语言回环", () => {
  for (const c of randomCases) {
    it(`[${c.lang}] ${c.key} -> ${c.msg.slice(0, 50)}`, () => {
      const cmds = JSON.parse(
        readFileSync(join(DATA_DIR, c.lang, "commands.json"), "utf-8"),
      ) as Record<string, string>;
      const parser = new CmdParser(cmds);
      const r = parser.capture(c.msg, c.key);
      expect(r).toEqual(c.vals);
    });
  }
});

describe("captureLine", () => {
  const zhCmds = JSON.parse(
    readFileSync(join(DATA_DIR, "zh_CN", "commands.json"), "utf-8"),
  ) as Record<string, string>;
  const enCmds = JSON.parse(
    readFileSync(join(DATA_DIR, "en_US", "commands.json"), "utf-8"),
  ) as Record<string, string>;
  const zn = new CmdParser(zhCmds);
  const en = new CmdParser(enCmds);

  it("真实多行 tickingarea list", () => {
    const msg = [
      "§a当前维度中的所有常加载区域的列表",
      "- testChunk: 0 0 0 到 15 0 15",
      "- test_area: 0 0 0 到 15 0 15",
      "2/10 常加载区域正在使用。",
    ].join("\n");
    expect(zn.captureLine(msg, "commands.tickingarea.inuse")).toEqual(["2", "10"]);
    expect(zn.captureLine(msg, "commands.tickingarea.noneExist.currentDimension")).toBeNull();
  });

  it("真实多行找 header", () => {
    const msg = [
      "当前维度中的所有常加载区域的列表",
      "- test: 0 0 0 到 15 0 15",
      "1/10 常加载区域正在使用。",
    ].join("\n");
    expect(zn.captureLine(msg, "commands.tickingarea-list.success.currentDimension")).toEqual([]);
  });

  it("en_US 多行 tickingarea list", () => {
    const msg = [
      "List of all ticking areas in current dimension",
      "- test: 0 0 0 to 15 0 15",
      "3/10 ticking areas in use.",
    ].join("\n");
    expect(en.captureLine(msg, "commands.tickingarea.inuse")).toEqual(["3", "10"]);
    expect(en.captureLine(msg, "commands.tickingarea.noneExist.currentDimension")).toBeNull();
  });

  it("§ 颜色码前缀行", () => {
    const msg = "§a§c§l2/10 常加载区域正在使用。";
    expect(zn.captureLine(msg, "commands.tickingarea.inuse")).toEqual(["2", "10"]);
  });

  it("多行中有无关行", () => {
    const msg = "something\nunrelated\n\n  \n2/10 常加载区域正在使用。\nfooter";
    expect(zn.captureLine(msg, "commands.tickingarea.inuse")).toEqual(["2", "10"]);
  });

  it("无匹配行返回 null", () => {
    expect(zn.captureLine("abc\ndef\nxyz", "commands.tickingarea.inuse")).toBeNull();
  });

  it("空消息返回 null", () => {
    expect(zn.captureLine("", "commands.tickingarea.inuse")).toBeNull();
  });

  it("空行消息返回 null", () => {
    expect(zn.captureLine("\n\n  \n", "commands.tickingarea.inuse")).toBeNull();
  });
});


