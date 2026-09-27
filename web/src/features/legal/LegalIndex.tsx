/**
 * LegalIndex.tsx — 32 篇协议的目录页
 *
 * 为什么值得单独做一页（01 号专篇 §1）：协议是"条款的构成"，用户找不到的条款
 * 等于没告知。所以这一页的目标不是"列全"，而是**让人两跳之内到达该看的那一篇**。
 *
 * 三条实现约束：
 *   · ★ 关键条款直达区（10 §6、14 §1、18、19、30、31 §3、32 §4）放在最上面 ——
 *     它们分别对应"我的权利 / 不拿去训练 / 退款 / 扣费 / 处置 / 赔偿上限 / 管辖"，
 *     是付费前后一定会被翻到的位置。
 *   · 六组分组沿用 docs/legal/README.md 的 A–F，缺项在编译期就看得见
 *     （LEGAL_DOCS 是常量数组，条数不对时上面的编号会跳号）。
 *   · 不做搜索框：32 篇里做全文搜索需要正文都进前端包，那是首屏预算的三倍；
 *     用「组 + 一句话摘要」的定位方式，代价小得多。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { GROUP_LABEL, KEY_CLAUSES, LEGAL_DOCS, type LegalGroup } from './legal-data';
import { IconChevronRight } from '../../ui/icons';

const GROUPS: LegalGroup[] = ['A', 'B', 'C', 'D', 'E', 'F'];

export function LegalIndex() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');

  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => (q
    ? LEGAL_DOCS.filter((d) => `${d.no}${d.title}${d.summary}`.toLowerCase().includes(q))
    : LEGAL_DOCS), [q]);

  return (
    <div className="legal-index">
      <header className="panel-head">
        <h2>条款与规则</h2>
        <p className="muted panel-sub">
          一共 {LEGAL_DOCS.length} 篇。不用一次读完，但下面这几段建议先看。
        </p>
      </header>

      {/* ── 关键条款直达 ─────────────────────────── */}
      <section className="legal-key">
        <h3 className="sec-title">这几段直接影响你</h3>
        <ul className="col key-list">
          {KEY_CLAUSES.map((k) => {
            const doc = LEGAL_DOCS.find((d) => d.no === k.docNo);
            if (!doc) return null;
            return (
              <li key={`${k.docNo}-${k.chapter}`}>
                <button
                  type="button" className="row key-item"
                  onClick={() => void navigate({ to: '/legal/$docNo', params: { docNo: doc.slug }, search: { a: String(k.chapter) } })}
                >
                  <span className="col grow">
                    <b>{k.label}</b>
                    <span className="muted key-why">{k.why}</span>
                  </span>
                  <IconChevronRight size={17} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="field legal-filter">
        <label htmlFor="lg-q">按标题或内容关键词找</label>
        <input
          id="lg-q" value={filter} maxLength={40} placeholder="比如：退款 / 未成年 / 举报"
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* ── 六组目录 ─────────────────────────────── */}
      {GROUPS.map((g) => {
        const rows = shown.filter((d) => d.group === g);
        if (!rows.length) return null;
        return (
          <section key={g} className="legal-group">
            <h3 className="sec-title">
              {GROUP_LABEL[g].name}
              <span className="muted group-desc">{GROUP_LABEL[g].desc}</span>
            </h3>
            <ul className="col legal-list">
              {rows.map((d) => (
                <li key={d.no}>
                  <button
                    type="button" className="row legal-item"
                    onClick={() => void navigate({ to: '/legal/$docNo', params: { docNo: d.slug } })}
                  >
                    <span className="legal-no muted">{d.no}</span>
                    <span className="col grow">
                      <b>{d.title}</b>
                      <span className="muted legal-sum">{d.summary}</span>
                    </span>
                    <IconChevronRight size={17} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <footer className="legal-foot">
        <p className="muted">
          每篇末尾都写明它和其他条款的关系。协议版本随构建更新，历史版本可在导出包里索取。
        </p>
      </footer>
    </div>
  );
}
