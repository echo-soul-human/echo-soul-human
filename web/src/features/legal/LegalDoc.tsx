/**
 * LegalDoc.tsx — 单篇协议阅读页
 *
 * 正文来源：`${BASE_URL}legal/${slug}.json`（构建时由 docs/legal/*.md 生成，
 * 不进 JS bundle —— 32 篇 × 3000 字进包会直接击穿首屏 180KB 预算）。
 *
 * ★ 关键条款锚点必须直达：目录页带 ?a=6 进来时要滚到"第六章"并高亮它。
 *   做法是给每个 `## 第N章 …` 标题算出稳定 id（legal-<no>-ch<N>），
 *   而不是依赖 markdown 自动生成的中文 slug —— 后者会因为标点变化而失配。
 *
 * 渲染安全：**不使用 dangerouslySetInnerHTML**。
 *   marked + dompurify 的组合在这里是多余的风险 —— 我们的法律文本只需要
 *   段落 / 列表 / 表格 / 加粗四种结构，自己解析就能做到，且完全没有 XSS 面。
 *   （角色输出的 Markdown 才需要 marked，那条路径另有 sanitise。）
 */
import { useEffect, useMemo } from 'react';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { LEGAL_DOCS, chapterAnchor, parseChapter } from './legal-data';
import { SkeletonRows } from '../../ui/Skeleton';
import { Empty } from '../../ui/Empty';
import { IconBack, IconChevronRight, IconWarning } from '../../ui/icons';

const routeApi = getRouteApi('/legal/$docNo');

export function LegalDoc() {
  const { docNo } = routeApi.useParams();
  const { a } = routeApi.useSearch();
  const navigate = useNavigate();

  // URL 里传的是 slug，内部编号用于算锚点 id
  const meta = useMemo(() => LEGAL_DOCS.find((d) => d.slug === docNo || d.no === docNo), [docNo]);

  const q = useQuery({
    queryKey: ['legal', meta?.slug],
    enabled: Boolean(meta),
    queryFn: async (): Promise<string> => {
      const res = await fetch(`${import.meta.env.BASE_URL}legal/${meta?.slug}.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error('LEGAL_' + res.status);
      const j = await res.json() as { body?: string };
      if (typeof j.body !== 'string') throw new Error('LEGAL_SHAPE');
      return j.body;
    },
    staleTime: 3_600_000,
  });

  const blocks = useMemo(() => (q.data ? parseMarkdown(q.data, meta?.no ?? '') : []), [q.data, meta]);

  // 锚点直达：等 DOM 有内容后再滚，否则 ref 里还是空的
  useEffect(() => {
    const chapter = a ? parseChapter(a) : null;
    if (!chapter || !meta || !blocks.length) return;
    const target = document.getElementById(chapterAnchor(meta.no, chapter));
    if (!target) return;
    target.classList.add('legal-flash');
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return () => target.classList.remove('legal-flash');
  }, [a, meta, blocks.length]);

  if (!meta) {
    return (
      <div className="legal-doc">
        <Empty
          title="找不到这一篇"
          hint="链接可能抄错了一位。回到目录挑一篇。"
          action={<button type="button" className="btn btn-primary" onClick={() => void navigate({ to: '/legal' })}>看全部条款</button>}
        />
      </div>
    );
  }

  const related = LEGAL_DOCS.filter((d) => d.group === meta.group && d.no !== meta.no).slice(0, 4);
  const h2s = blocks.filter(isH2);

  return (
    <article className="legal-doc">
      <header className="legal-head">
        <button type="button" className="icon-btn legal-back" onClick={() => void navigate({ to: '/legal' })} aria-label="回目录">
          <IconBack size={19} />
        </button>
        <div className="col grow">
          <h1 className="legal-title">{meta.title}</h1>
          <p className="muted legal-meta">
            {meta.no} 号专篇 · 更新于 {meta.updated}
          </p>
        </div>
      </header>

      {/* 本篇的关键段落导航：读长文时最需要的就是"跳到我要的那章" */}
      {h2s.length ? (
        <nav className="legal-toc scroll-pane-x" aria-label="本章目录">
          {h2s.map((b) => (
            <a key={b.id ?? b.text} className="toc-chip" href={`#${b.id ?? ''}`}>{b.text}</a>
          ))}
        </nav>
      ) : null}

      {q.isLoading ? <SkeletonRows count={8} h={22} gap={14} /> : null}

      {q.isError ? (
        <div className="legal-fail">
          <p><IconWarning size={16} /> <span>正文没取到。这是部署侧的文件问题，不是你的网络。</span></p>
          <button type="button" className="btn" onClick={() => void q.refetch()}>再试一次</button>
        </div>
      ) : null}

      <div className="legal-body scroll-pane">
        {blocks.map((b, i) => <Block key={blockKey(b, i)} b={b} />)}
      </div>

      {related.length ? (
        <footer className="legal-rel">
          <h2 className="sec-title">同一组里的其他篇</h2>
          <ul className="col set-nav">
            {related.map((r) => (
              <li key={r.no}>
                <button type="button" className="row set-link" onClick={() => void navigate({ to: '/legal/$docNo', params: { docNo: r.slug } })}>
                  <span className="muted legal-no">{r.no}</span>
                  <span className="grow">{r.title}</span>
                  <IconChevronRight size={16} />
                </button>
              </li>
            ))}
          </ul>
        </footer>
      ) : null}
    </article>
  );
}

// ── 极简 markdown 解析（只处理我们法律文本用到的结构）──
type Block =
  | { type: 'h1' | 'h2' | 'h3' | 'p'; id?: string | undefined; text: string; html: Inline[] }
  | { type: 'ul' | 'ol'; items: Inline[][] }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'quote'; text: string }
  | { type: 'code'; lines: string[] };

interface Inline { t: string; bold?: boolean; code?: boolean }

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20,
};

/**
 * 章节标题 → 稳定锚点 id。
 * 认两种写法：`## 第三章 XXX`（文档实际用法）与 `## 3. XXX`。
 */
function chapterId(no: string, line: string): string | undefined {
  const cn = /^#{2,3}\s*第([一二三四五六七八九十]{1,3})章/.exec(line)?.[1];
  if (cn) {
    const n = CN_NUM[cn];
    return n ? chapterAnchor(no, n) : undefined;
  }
  const num = /^#{2,3}\s*(\d{1,2})[\.、]/.exec(line)?.[1];
  if (num) return chapterAnchor(no, Number(num));
  return undefined;
}

function parseMarkdown(src: string, no: string): Block[] {
  const out: Block[] = [];
  const lines = src.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) { i++; continue; }

    // 围栏代码块
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) { buf.push(lines[i] ?? ''); i++; }
      i++;
      out.push({ type: 'code', lines: buf });
      continue;
    }

    // 引用块（文档头部那句"版本 / 关联"就是它）
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) { buf.push((lines[i] ?? '').replace(/^>\s?/, '')); i++; }
      out.push({ type: 'quote', text: buf.join(' ') });
      continue;
    }

    // 表格
    if (/^\|/.test(line) && /^\|[\s:-]+\|/.test(lines[i + 1] ?? '')) {
      const cells = (l: string) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i] ?? '')) { rows.push(cells(lines[i] ?? '')); i++; }
      out.push({ type: 'table', head, rows });
      continue;
    }

    // 列表
    if (/^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      const ordered = /^\d+[.)]\s+/.test(line);
      const items: Inline[][] = [];
      while (i < lines.length && ((ordered && /^\d+[.)]\s+/.test(lines[i] ?? '')) || (!ordered && /^[-*]\s+/.test(lines[i] ?? '')))) {
        items.push(inline((lines[i] ?? '').replace(/^([-*]|\d+[.)])\s+/, '')));
        i++;
      }
      out.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }

    // 标题
    const hm = /^#{1,3}\s+/.exec(line);
    if (hm) {
      const level = (hm[0].trim().length) as 1 | 2 | 3;
      const text = line.replace(/^#{1,3}\s+/, '');
      out.push({
        type: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3',
        id: level <= 2 ? chapterId(no, line) : undefined,
        text,
        html: inline(text),
      });
      i++;
      continue;
    }

    // 段落：连续非空、非特殊行合并成一段
    const buf: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() && !isSpecial(lines[i] ?? '')) { buf.push(lines[i] ?? ''); i++; }
    const text = buf.join(' ');
    out.push({ type: 'p', text, html: inline(text) });
  }
  return out;
}

function isSpecial(l: string): boolean {
  return /^(#{1,3}\s|[-*]\s|\d+[.)]\s|\||>|```)/.test(l);
}

/** 只认 **粗体** 与 `代码`；其余一律当纯文本 —— 这正是没有 XSS 面的原因 */
function inline(s: string): Inline[] {
  const parts: Inline[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ t: s.slice(last, m.index) });
    const raw = m[0];
    if (raw.startsWith('**')) parts.push({ t: raw.slice(2, -2), bold: true });
    else parts.push({ t: raw.slice(1, -1), code: true });
    last = m.index + raw.length;
  }
  if (last < s.length) parts.push({ t: s.slice(last) });
  return parts.length ? parts : [{ t: s }];
}

/** 只有标题成员带 id；其余用下标兜底，集中一处而不是散在 JSX 里 */
function blockKey(b: Block, i: number): string {
  return 'id' in b && b.id ? b.id : 'b' + i;
}

/** h2 类型守卫：Block 的标题成员才同时有 id/text/html */
function isH2(b: Block): b is Extract<Block, { html: Inline[] }> & { type: 'h2' } {
  return b.type === 'h2';
}

function Block({ b }: { b: Block }) {
  switch (b.type) {
    case 'h1': return <h1 id={b.id} className="lg-h1">{b.text}</h1>;
    case 'h2': return <h2 id={b.id} className="lg-h2">{renderInline(b.html)}</h2>;
    case 'h3': return <h3 id={b.id} className="lg-h3">{renderInline(b.html)}</h3>;
    case 'p': return <p className="lg-p">{renderInline(b.html)}</p>;
    case 'quote': return <blockquote className="lg-quote muted">{b.text}</blockquote>;
    case 'code': return <pre className="lg-code"><code>{b.lines.join('\n')}</code></pre>;
    case 'ul': return <ul className="lg-ul">{b.items.map((it, i) => <li key={i}>{renderInline(it)}</li>)}</ul>;
    case 'ol': return <ol className="lg-ol">{b.items.map((it, i) => <li key={i}>{renderInline(it)}</li>)}</ol>;
    case 'table': return (
      <div className="lg-table-wrap scroll-pane-x">
        <table className="lg-table">
          <thead><tr>{b.head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    default: return null;
  }
}

function renderInline(parts: Inline[]) {
  return parts.map((p, i) => {
    // 全部走 children 文本节点，React 会转义 —— 没有任何地方插入原始 HTML
    if (p.code) return <code key={i} className="lg-inline-code">{p.t}</code>;
    if (p.bold) return <b key={i}>{p.t}</b>;
    return <span key={i}>{p.t}</span>;
  });
}
