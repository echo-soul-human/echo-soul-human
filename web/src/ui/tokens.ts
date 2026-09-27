/**
 * tokens.ts — 组件侧唯一允许出现的"字面量"清单
 *
 * check-styles.mjs 会拦十六进制色值、rgba()/hsl() 函数与 px 字号。
 * 但 SVG 的 stroke-width 不是颜色也不是字号，它必须是**无单位数字**：
 *   `stroke-width="1.5"` ✓    `stroke-width="var(--sp-2)"` ✗（那是长度不是数）
 * 而线性图标的粗细恰恰是"有没有 AI 味"的分界线之一（分册 §4：emoji 当图标 = 重灾区），
 * 所以这个值需要名字，而不是散落在 20 个组件里各写一遍。
 *
 * 同理：动画循环里的位移幅度、canvas 画布像素尺寸属于 JS 常量，
 * 不能塞进 CSS 变量（CSS 变量在 canvas 上下文里根本不解析）。
 * 这些值集中在这里，改动只需搜一处，且不会绕过皮肤系统 ——
 * 因为它们**不参与配色**。
 */

/** 线性图标统一描边宽度（SVG 无单位数，非颜色非字号） */
export const ICON_STROKE = 1.5;

/** 焦点陷阱轮询周期（ms）：见 Sheet.tsx 的注释 */
export const FOCUS_POLL_MS = 120;

/** Toast 自动消失（ms）。危险类错误不自动消失，由调用方传 duration=0 */
export const TOAST_AUTO_DISMISS_MS = 3600;

/** 消息列表估算行高（虚拟列表 initialMeasureEstimates 用，单位是布局像素不是字号） */
export const ROW_ESTIMATE_PX = 76;
