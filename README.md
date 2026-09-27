# renji-companion

AI 情感陪伴聊天产品。**与尚贤圈完全独立**：新仓库、新品牌、新 Supabase 项目、新域名，不共用账号。

正式名待定稿（`docs/HANDOFF.md` 附录 A 有 15 个候选）。定稿前不得发布。

## 一句话

让用户和自己选定的 AI 角色长期聊下去：角色记得你说过的话、会主动找你、说话不会跑偏，**而且你养得起**。

## 形态

| 端 | 实现 | 分发 |
|---|---|---|
| 网页 / PC | Vite + React 18 + TS | GitHub Pages |
| iOS | 主屏 WebApp（不上架 App Store） | 同上 |
| 安卓 | **Kotlin + Jetpack Compose 原生**（不套壳） | Supabase Storage CDN 直链 APK |
| 后端 | Supabase：Auth / Postgres+pgvector / Storage / Realtime / Edge Functions | — |
| 模型 | 内置仅 DeepSeek Flash；BYOK 支持 OpenAI 兼容 + Anthropic | — |
| 售卖 | 爱发电，OAuth + 订单比对全自动发放 | — |

## 先读什么

1. **`docs/HANDOFF.md`** — 总纲。§3 硬约束是拍过板的决定，**不许自行"优化"掉**。
2. `docs/架构与阶段划分.md` — 谁调谁、数据放哪、按什么顺序做。
3. `docs/开发任务总清单.md` — 174 项任务与依赖。
4. `docs/验收清单.md` — 132 条可执行检查项。
5. 分册：网页端 / 安卓端 / 后端与数据库 / 模型与计费 / 多模态 / 增长运营。

## 四道 CI 防线（必须常驻，不许为赶进度关掉）

```bash
npm run check          # 串起下面四条
```

| 脚本 | 防的是什么 |
|---|---|
| `scripts/secret-scan.mjs` | 明文密钥进仓库（尚贤圈有 4 个 token 文件，靠 .gitignore 挡住了，但那是运气） |
| `scripts/check-sql.mjs` | **`$$` 被 JS 字符串替换转义成 `$`** → SQL 静默损坏。尚贤圈为此连续两轮假修复。 |
| `scripts/check-prefix.mjs` | 静态前缀混进时间戳 → 提示词缓存击穿 → **单轮成本涨 3.2 倍且不报错，只是悄悄亏钱** |
| `scripts/audit-sw.mjs` | 有人"顺手"给 Service Worker 加缓存 → 旧 UI 配新接口的地狱级 bug |

## 开工前必须定的三件事

| 项 | 为什么卡 |
|---|---|
| 正式名与 slug | 包名 / 仓库名 / PWA name 发布后改不动。`gen-manifest.mjs` 会直接拒绝生成 |
| 爱发电 OAuth 与订单 API 是否可用 | 不通则整个归因方案要换（`docs/分册-模型与计费.md` §5.2 有 L1/L2/L3 三级） |
| 首批官方角色清单 | P1 联调就要用，且直接决定免费档给的是哪一个 |

## 边界（写在这里，防止后来 agent 反复试探）

- 不做露骨色情内容生成，不做"绕过上游模型内容过滤"的功能，不以"无限制/无违禁词"为卖点。
- 产品走 BYOK + 平台内置双轨：BYOK 链路的内容边界由用户的模型接入方决定；平台内置链路走供应商默认配置。
- 这条不因为用户协议、免责声明或"用户自担责任"的架构话术而改变。

## 目录

```
manifest.json          版本清单（唯一可手写版本号的地方）
RELEASE_NOTES.md       更新说明唯一来源
docs/                  11 份工程文档 + legal/ 协议文本
web/                   Vite + React18 + TS
android/               Kotlin + Compose
supabase/
  migrations/          NNN_*.sql 编号迁移（幂等，末尾带自检）
  functions/
    _shared/prefix/    ★ 静态前缀（改它 = 击穿缓存）
scripts/               四道 CI 防线 + 生成器
shared/                跨端契约单一源（生成 TS 类型与 Kotlin data class）
```
