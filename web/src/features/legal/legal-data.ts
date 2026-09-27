/**
 * legal-data.ts — 32 篇协议的目录元数据 + 关键条款锚点
 *
 * ⚠ 这里是**索引**，不是正文。正文由后端下发（docs/legal/*.md → 静态 JSON），
 *   LegalDoc.tsx 负责取回并渲染；本文件只保证两件事：
 *     1. 32 篇按组齐全，缺项在开发期就能看到（README 里的 A–F 分组）；
 *     2. 被反复引用的关键条款有直达锚点 —— 勾选门、退款、扣费、处置分级这些
 *        用户在付费前一定会翻的条目，不能让人在 3000 字里自己找。
 */

export interface LegalDocMeta {
  /** 两位编号，URL 与文件名都用它 */
  no: string;
  slug: string;
  title: string;
  group: LegalGroup;
  /** 一句话："这篇讲什么"，给目录页用 */
  summary: string;
  /** 更新日期，来自文档头部版本行 */
  updated: string;
}

export type LegalGroup = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export const GROUP_LABEL: Record<LegalGroup, { name: string; desc: string }> = {
  A: { name: '服务与关系', desc: '我们提供什么、不提供什么、能不能改、能不能停' },
  B: { name: '账号与身份', desc: '注册、归属、年龄、注销' },
  C: { name: '隐私与数据', desc: '收集什么、怎么用、存在哪、能不能拿走' },
  D: { name: '钱', desc: '定价、到账、退款、额度计费、创作者分成' },
  E: { name: '内容与安全', desc: '行为规范、举报审核、知识产权' },
  F: { name: '责任与争议', desc: '禁止行为、违约免责、争议解决' },
};

export const LEGAL_DOCS: LegalDocMeta[] = [
  // ── A 服务与关系 ────────────────────────────────
  { no: '01', slug: 'terms', title: '用户服务协议（总纲）', group: 'A', updated: '2026-09-26', summary: '所有条款的骨架：协议怎么成立、双方义务、通知怎么送达。' },
  { no: '02', slug: 'scope', title: '服务说明与使用范围', group: 'A', updated: '2026-09-26', summary: '这个产品能做什么、不承诺什么，以及为什么角色是虚构的。' },
  { no: '03', slug: 'byok', title: 'BYOK 第三方服务接入条款', group: 'A', updated: '2026-09-26', summary: '填自己的 Key 之后，责任怎么切分、我们不经手什么。' },
  { no: '04', slug: 'changes', title: '服务变更、中断与终止', group: 'A', updated: '2026-09-26', summary: '我们要改动或停掉某项功能时，会提前多久、用什么方式告诉你。' },
  { no: '05', slug: 'oss', title: '开源组件与第三方依赖声明', group: 'A', updated: '2026-09-26', summary: '用到的开源库和许可证清单。' },

  // ── B 账号与身份 ────────────────────────────────
  { no: '06', slug: 'account', title: '账号注册与管理规则', group: 'B', updated: '2026-09-26', summary: '匿名账号也算正式账号；换设备时怎么找回。' },
  { no: '07', slug: 'ownership', title: '账号归属与转让限制', group: 'B', updated: '2026-09-26', summary: '账号不能卖、不能借，原因写在里面。' },
  { no: '08', slug: 'age', title: '年龄声明与身份规则', group: 'B', updated: '2026-09-26', summary: '为什么要声明年龄，以及我们不核验证件。' },
  { no: '09', slug: 'deletion', title: '账号注销与数据删除流程', group: 'B', updated: '2026-09-26', summary: '注销会删什么、留什么、多久生效，导出为什么要先做。' },

  // ── C 隐私与数据 ────────────────────────────────
  { no: '10', slug: 'privacy', title: '隐私政策（总纲）', group: 'C', updated: '2026-09-26', summary: '个人信息处理的主干；第六章是你行使权利的时限。' },
  { no: '11', slug: 'collect', title: '个人信息收集与使用清单', group: 'C', updated: '2026-09-26', summary: '逐条列出我们收哪些字段、为了什么。' },
  { no: '12', slug: 'storage', title: '本地存储、Cookie 与推送标识', group: 'C', updated: '2026-09-26', summary: '设备上存了什么，iOS 清存储会带来什么后果。' },
  { no: '13', slug: 'sensitive', title: '敏感个人信息处理规则', group: 'C', updated: '2026-09-26', summary: '聊天里出现的健康、情感等内容的特殊处理。' },
  { no: '14', slug: 'training', title: '训练数据使用政策', group: 'C', updated: '2026-09-26', summary: '第一章是核心承诺：你的聊天不会被拿去训练模型。' },
  { no: '15', slug: 'crossborder', title: '数据存储跨境与第三方共享', group: 'C', updated: '2026-09-26', summary: '数据放在哪、经过谁的服务器、安全事件怎么告知。' },

  // ── D 钱 ────────────────────────────────────────
  { no: '16', slug: 'pricing', title: '虚拟商品与服务定价规则', group: 'D', updated: '2026-09-26', summary: '档位与加量包怎么定价、调价怎么通知。' },
  { no: '17', slug: 'payment', title: '支付到账与权益生效', group: 'D', updated: '2026-09-26', summary: '第七章是自助重查通道：付了没到账怎么办，不用找客服。' },
  { no: '18', slug: 'refund', title: '退款政策', group: 'D', updated: '2026-09-26', summary: '哪些能退、哪些不退、未成年人充值怎么处理。' },
  { no: '19', slug: 'billing', title: '额度计费与扣费规则', group: 'D', updated: '2026-09-26', summary: '预冻结与结算怎么算，余额耗尽时会发生什么。' },
  { no: '20', slug: 'creator', title: '创作者分成与角色卡交易规则', group: 'D', updated: '2026-09-26', summary: '卖卡的分成比例与结算口径（二期）。' },

  // ── E 内容与安全 ────────────────────────────────
  { no: '21', slug: 'fraud', title: '反诈与交易安全提示', group: 'E', updated: '2026-09-26', summary: '站内不做私信，任何"官方私聊你"都是假的。' },
  { no: '22', slug: 'ugc', title: '用户生成内容规范', group: 'E', updated: '2026-09-26', summary: '你写的人设、传的图，哪些不能出现。' },
  { no: '23', slug: 'card-copyright', title: '角色卡与指令的著作权声明', group: 'E', updated: '2026-09-26', summary: '人设文本是谁的作品，被抄了能怎么办。' },
  { no: '24', slug: 'ip', title: '知识产权声明', group: 'E', updated: '2026-09-26', summary: '我们的商标、界面、素材的归属。' },
  { no: '25', slug: 'moderation', title: '举报、审核与申诉流程', group: 'E', updated: '2026-09-26', summary: '第三章是怎么举报，第六章是申诉 —— 那是你的权利。' },
  { no: '26', slug: 'conduct', title: '内容安全与行为规范', group: 'E', updated: '2026-09-26', summary: '对输出内容的过滤边界与原因。' },
  { no: '27', slug: 'minors', title: '未成年人保护规则', group: 'E', updated: '2026-09-26', summary: '未成年账号的功能限制与家长通道。' },
  { no: '28', slug: 'wellbeing', title: '情绪依赖提示与健康使用', group: 'E', updated: '2026-09-26', summary: '我们会在哪几个时点提醒，以及危机情形怎么办。' },
  { no: '29', slug: 'ai-label', title: 'AI 生成内容标识说明', group: 'E', updated: '2026-09-26', summary: '为什么分享图上一定有那句"内容由 AI 生成"。' },

  // ── F 责任与争议 ────────────────────────────────
  { no: '30', slug: 'prohibited', title: '禁止行为与账号处置分级', group: 'F', updated: '2026-09-26', summary: '第二章是禁止清单，第三章是处置分级。' },
  { no: '31', slug: 'liability', title: '违约责任与免责', group: 'F', updated: '2026-09-26', summary: '第三章是赔偿上限，第四章是免责情形。' },
  { no: '32', slug: 'dispute', title: '争议解决与法律适用', group: 'F', updated: '2026-09-26', summary: '按什么顺序解决、适用什么法律、去哪里解决。' },
];

/** 章节号 → 中文写法（文档里用的是"第 N 章"） */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * ★ 关键条款直达锚点。
 *
 * 这七个是产品里会被反复指过去的位置：勾选门要指 14 §1（"不拿去训练"这条承诺），
 * 额度页要指 19，退款入口要指 18，处置通知要指 30，争议要指 32 §4（管辖）。
 * 做成锚点而不是新页面，是因为用户点开条款就该看到原文所在的段落，
 * 而不是又一层包装过的解释。
 */
export const KEY_CLAUSES: { docNo: string; chapter: number; label: string; why: string }[] = [
  { docNo: '10', chapter: 6, label: '隐私政策 · 第六章 您的权利与时限', why: '你要导出、更正、删除时，我们有几天必须回应' },
  { docNo: '14', chapter: 1, label: '训练数据 · 第一章 核心承诺', why: '你的聊天不会被拿去训练模型 —— 注册前该看这句' },
  { docNo: '18', chapter: 1, label: '退款政策 全篇', why: '买之前要知道哪些能退' },
  { docNo: '19', chapter: 1, label: '额度计费 全篇', why: '为什么一轮扣这么多，预冻结是怎么回事' },
  { docNo: '30', chapter: 2, label: '禁止行为与处置分级 全篇', why: '什么行为会导致账号被处置' },
  { docNo: '31', chapter: 3, label: '违约责任 · 第三章 责任限制', why: '赔偿上限，以及法定不得免除的例外' },
  { docNo: '32', chapter: 4, label: '争议解决 · 第四章 管辖', why: '真出事时去哪个法院' },
];

/** 锚点 id：LegalDoc 会把正文标题映射成同样的 id，两边必须一致 */
export function chapterAnchor(docNo: string, chapter: number): string {
  return `legal-${docNo}-ch${chapter}`;
}

export function chapterHeadingText(chapter: number): string {
  const cn = CN_NUM[chapter - 1] ?? String(chapter);
  return `第${cn}章`;
}

/** 供锚点解析失败时的兜底：把 "§6" 这类写法转成章节号 */
export function parseChapter(raw: string): number | null {
  const n = Number(raw.replace(/^§?/, ''));
  return Number.isInteger(n) && n > 0 && n <= 12 ? n : null;
}
