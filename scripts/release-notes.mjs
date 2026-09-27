/**
 * release-notes.mjs — 解析 RELEASE_NOTES.md
 *
 * 存在理由：HANDOFF §3-E4 要求「更新说明唯一来源」。以前 version.json 里的
 * `notes_file` 指向仓库根的 RELEASE_NOTES.md，而这个文件从没被发布进 dist ——
 * 指针是悬空的，更新弹窗因此永远拿不到"更新了什么"。
 * 这里把那份 Markdown 切成结构化数据，交给 gen-manifest 发布成 JSON。
 *
 * 约定格式（见 RELEASE_NOTES.md 头部）：`## <版本号> · <日期>` + `- ` 条目。
 */

/** 返回所有版本段，按文件出现顺序（最新在最前） */
export function parseReleaseNotes(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const out = [];
  let cur = null;
  let inComment = false;

  for (const line of lines) {
    if (line.trim() === '<!--') inComment = true;
    if (inComment) { if (line.trim() === '-->') inComment = false; continue; }

    const head = /^##\s+(\S+)\s*·\s*(.+?)\s*$/.exec(line);
    if (head) {
      cur = { version: head[1], date: head[2], items: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^##\s/.test(line)) { cur = null; continue; }        // 非约定格式的段头，停止收集
    if (/^---+\s*$/.test(line)) { cur = null; continue; }    // 分隔线之后不属于本段
    const item = /^-\s+(.*)$/.exec(line);
    if (item && item[1].trim()) cur.items.push(item[1].trim());
  }
  return out;
}

/** 最新一段；没有可用段落返回 null */
export function latestNotes(md) {
  return parseReleaseNotes(md).find((s) => s.items.length) ?? null;
}
