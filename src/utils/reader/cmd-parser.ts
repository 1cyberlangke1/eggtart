function buildPattern(template: string): RegExp {
  let p = template.replace(/%\d+\$[sd]/g, "%%CAP%%");
  p = p.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  p = p.replace(/%%CAP%%/g, "(.+?)");
  return new RegExp("^" + p + "$");
}

/**
 * 命令输出解析器。绑定当前语言的 templates (commands.json)，
 * 对每条命令输出按模板 key 匹配并提取占位符值。
 *
 * capture 返回值：
 *   null         — 不匹配（或 key 不存在）
 *   []           — 匹配，模板无占位符
 *   ["a", "b"]   — 匹配，按 %N$s 顺序
 */
export class CmdParser {
  private cache = new Map<string, RegExp>();

  constructor(private templates: Record<string, string>) {}

  getRaw(key: string): string | undefined {
    return this.templates[key]
  }

  /** 匹配消息 msg 到模板 key 并提取 %N$s 的值 */
  capture(msg: string, key: string): string[] | null {
    let re = this.cache.get(key);
    if (!re) {
      const tmpl = this.templates[key];
      if (!tmpl) return null;
      re = buildPattern(tmpl);
      this.cache.set(key, re);
    }
    return msg.match(re)?.slice(1) ?? null;
  }

  /**
   * 逐行解析，返回第一行匹配的结果。
   * 自动去掉每行开头的 § 颜色码，跳过空行。
   */
  captureLine(msg: string, key: string): string[] | null {
    for (const raw of msg.split("\n")) {
      const line = raw.replace(/§./g, "").trim();
      if (!line) continue;
      const r = this.capture(line, key);
      if (r !== null) return r;
    }
    return null;
  }
}
