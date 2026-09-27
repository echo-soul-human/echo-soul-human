/**
 * fix-frontend-types.mjs — 一次性修正代理产出代码里的编译错误
 *
 * 全部错误都属同一类：exactOptionalPropertyTypes 下，可选属性不接受**显式 undefined**，
 * 而调用方从表单/查询结果里拿到的本来就是 `T | undefined` 并直接透传。
 * 正确的修法是在**类型声明**侧允许 `| undefined`（承认「透传可能为空的值」是合法用法），
 * 而不是逼每个调用点写条件展开 —— 后者噪音大、易漏、且把意图藏起来。
 *
 * 另有三处不是类型严格性问题，是真实写法错误：
 *   · inputMode="latin" 不是合法值（React 会忽略，等于没设）
 *   · 联合类型上直接取 r.urgent：部分成员没有该字段
 *   · Block 联合的 id 只在标题成员上存在，却在遍历所有块时取用
 *
 * 用法：node fix-frontend-types.mjs（在 web/ 目录下执行）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const edits = [];
const apply = (file, from, to, why) => {
  const p = file;
  if (!existsSync(p)) { edits.push([false, file, why + '（文件不存在）']); return; }
  const s = readFileSync(p, 'utf8');
  // ★ 必须先判 to：插入型修改的 from 在插入之后**依然存在**，
  //   若先判 from 就会在重复运行时反复插入（已经真实踩过一次）。
  if (s.includes(to)) { edits.push([true, file, why + '（已应用）']); return; }
  if (!s.includes(from)) { edits.push([false, file, why + '（锚点未命中）']); return; }
  if (s.split(from).length - 1 > 1) { edits.push([false, file, why + '（锚点不唯一）']); return; }
  writeFileSync(p, s.replace(from, () => to));
  edits.push([true, file, why]);
};

/** 消除重复片段：把「A A」压成「A」，用于清理被重复插入的内容 */
const collapse = (file, snippet, why) => {
  const p = file;
  if (!existsSync(p)) { edits.push([false, file, why + '（文件不存在）']); return; }
  const s = readFileSync(p, 'utf8');
  const doubled = snippet + snippet;
  if (!s.includes(doubled)) { edits.push([true, file, why + '（无需处理）']); return; }
  writeFileSync(p, s.replace(doubled, () => snippet));
  edits.push([true, file, why]);
};

// ── 1. rpc.ts：透传可能为空的值，类型上允许 undefined ──
apply('src/features/rpc.ts',
`export interface UpdateCharacterPatch {
  name?: string; tagline?: string; persona?: string; greeting?: string;
  examples?: ExampleDialog[]; avatar?: string; portrait?: string; voice?: string;
  emotionPortraits?: Record<string, string>;
}`,
`export interface UpdateCharacterPatch {
  // 显式允许 undefined：表单字段天然是 string | undefined，
  // exactOptionalPropertyTypes 下不声明就会逼每个调用点写条件展开。
  name?: string | undefined;
  tagline?: string | undefined;
  persona?: string | undefined;
  greeting?: string | undefined;
  examples?: ExampleDialog[] | undefined;
  avatar?: string | undefined;
  portrait?: string | undefined;
  voice?: string | undefined;
  emotionPortraits?: Record<string, string> | undefined;
}`,
'UpdateCharacterPatch 允许显式 undefined');

// ── 2. Avatar：群聊成员数组允许直接透传 ──
apply('src/ui/Avatar.tsx',
'  /** 群聊多角色时传数组，叠放 */\n  group?: { src?: string | null; name: string }[];',
'  /** 群聊多角色时传数组，叠放。允许显式 undefined 以便调用方直接透传 */\n  group?: { src?: string | null; name: string }[] | undefined;',
'AvatarProps.group 允许显式 undefined');

// ── 3. BYOK 输入框：latin 不是合法的 inputMode ──
apply('src/features/byok/ByokPanel.tsx',
'inputMode="latin"',
'inputMode="text" autoCapitalize="off"',
'inputMode="latin" 非合法值，React 会忽略');

// ── 4. 举报类别：urgent 只在部分成员上 ──
apply('src/features/community/report.tsx',
'{r.urgent ? <span className="report-urgent">加急</span> : null}',
"{'urgent' in r && r.urgent ? <span className=\"report-urgent\">加急</span> : null}",
'联合类型上用 in 收窄再取 urgent');

// ── 5. LegalDoc：Block 的 id 只在标题成员上 ──
apply('src/features/legal/LegalDoc.tsx',
"  | { type: 'h1' | 'h2' | 'h3' | 'p'; id?: string; text: string; html: Inline[] }",
"  | { type: 'h1' | 'h2' | 'h3' | 'p'; id?: string | undefined; text: string; html: Inline[] }",
'Block 标题成员的 id 允许显式 undefined');

apply('src/features/legal/LegalDoc.tsx',
`      {blocks.some((b) => b.type === 'h2') ? (
        <nav className="legal-toc scroll-pane-x" aria-label="本章目录">
          {blocks.filter((b) => b.type === 'h2').map((b) => (
            <a key={b.id} className="toc-chip" href={\`#\${b.id}\`}>{b.text}</a>
          ))}
        </nav>
      ) : null}`,
`      {h2s.length ? (
        <nav className="legal-toc scroll-pane-x" aria-label="本章目录">
          {h2s.map((b) => (
            <a key={b.id ?? b.text} className="toc-chip" href={\`#\${b.id ?? ''}\`}>{b.text}</a>
          ))}
        </nav>
      ) : null}`,
'章节导航改用显式类型守卫，不再对全联合取 id');

apply('src/features/legal/LegalDoc.tsx',
'        {blocks.map((b, i) => <Block key={b.id ?? i} b={b} />)}',
'        {blocks.map((b, i) => <Block key={blockKey(b, i)} b={b} />)}',
'遍历所有块时用统一的取键函数，避免取不存在的 id');

apply('src/features/legal/LegalDoc.tsx',
'function Block({ b }: { b: Block }) {',
`/** 只有标题成员带 id；其余用下标兜底，集中一处而不是散在 JSX 里 */
function blockKey(b: Block, i: number): string {
  return 'id' in b && b.id ? b.id : 'b' + i;
}

/** h2 类型守卫：Block 的标题成员才同时有 id/text/html */
function isH2(b: Block): b is Extract<Block, { html: Inline[] }> & { type: 'h2' } {
  return b.type === 'h2';
}

function Block({ b }: { b: Block }) {`,
'补 blockKey 与 isH2 两个集中式辅助');

// h2s 派生值插在 related 之后（紧邻 return，作用域确定）
apply('src/features/legal/LegalDoc.tsx',
'  const related = LEGAL_DOCS.filter((d) => d.group === meta.group && d.no !== meta.no).slice(0, 4);',
'  const related = LEGAL_DOCS.filter((d) => d.group === meta.group && d.no !== meta.no).slice(0, 4);\n  const h2s = blocks.filter(isH2);',
'插入 h2s 派生值供章节导航使用');

// ── 6. CreditPage：查询返回与组件 props 允许显式 undefined ──
apply('src/features/billing/CreditPage.tsx',
'    queryFn: async ({ pageParam }): Promise<{ rows: LedgerRow[]; next?: number }> => {',
'    queryFn: async ({ pageParam }): Promise<{ rows: LedgerRow[]; next?: number | undefined }> => {',
'分页返回允许显式 undefined 的 next');

apply('src/features/billing/CreditPage.tsx',
'function PlansTable({ plans, loading, currentTier }: { plans: PlanRow[]; loading: boolean; currentTier?: string }) {',
'function PlansTable({ plans, loading, currentTier }: { plans: PlanRow[]; loading: boolean; currentTier?: string | undefined }) {',
'PlansTable 的 currentTier 允许显式 undefined');

// ── 7. Avatar：src 允许显式 undefined + CSS 自定义属性需断言 ──
apply('src/ui/Avatar.tsx',
'  src?: string | null;',
'  /** 允许显式 undefined：调用方常把可能为空的头像路径直接透传 */\n  src?: string | null | undefined;',
'AvatarProps.src 允许显式 undefined');

apply('src/ui/Avatar.tsx',
"        style={{ '--stack-size': `${size}px`, ...style }}",
"        // CSS 自定义属性不在 CSSProperties 的已知键里，必须断言\n        style={{ '--stack-size': `${size}px`, ...style } as CSSProperties}",
'--stack-size 断言为 CSSProperties');

// ── 8. ShareImage：索引结果可能 undefined，放宽 fallback ──
apply('src/features/share/ShareImage.tsx',
'  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;',
`  // fallback 放宽为 string | undefined：TOKENS 在 noUncheckedIndexedAccess 下
  // 索引结果本就可能是 undefined，逼调用点逐个写 ?? '' 只会产出 11 处噪音。
  const v = (name: string, fallback: string | undefined) =>
    css.getPropertyValue(name).trim() || fallback || '';`,
'v() 的 fallback 放宽为 string | undefined');

// ── 9. 清理被重复插入的内容（apply 判断顺序缺陷造成）──
collapse('src/features/legal/LegalDoc.tsx',
'  const h2s = blocks.filter(isH2);\n',
'去重：h2s 声明被插了两次');

collapse('src/features/legal/LegalDoc.tsx',
`/** 只有标题成员带 id；其余用下标兜底，集中一处而不是散在 JSX 里 */
function blockKey(b: Block, i: number): string {
  return 'id' in b && b.id ? b.id : 'b' + i;
}

/** h2 类型守卫：Block 的标题成员才同时有 id/text/html */
function isH2(b: Block): b is Extract<Block, { html: Inline[] }> & { type: 'h2' } {
  return b.type === 'h2';
}

`,
'去重：blockKey/isH2 被插了两次');

// ── 报告 ──
let okCount = 0;
for (const [ok, file, why] of edits) {
  console.log((ok ? '  ok   ' : '  MISS ') + file.padEnd(46) + why);
  if (ok) okCount++;
}
console.log(`\n${okCount}/${edits.length} 处已应用`);
process.exit(okCount === edits.length ? 0 : 1);
