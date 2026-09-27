/**
 * CostPage.tsx — 成本优化独立页
 *
 * CostPanel 本身是会话内的抽屉组件（需要 sessionId），而设置页要能直接跳到
 * 「成本」页，所以这里包一层：取最近一次会话作为默认上下文。
 * 没有会话时给出可操作的引导，而不是空白页。
 */
import { Link } from '@tanstack/react-router';
import { CostPanel } from './CostPanel';
import { Empty } from '../../ui/Empty';

export function CostPage() {
  // 与主屏快捷方式、ChatView 共用同一个键，保证"最近会话"语义一致
  const sessionId = typeof localStorage !== 'undefined'
    ? localStorage.getItem('echosoul.lastSession')
    : null;

  if (!sessionId) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>成本</h1>
          <p className="muted">先找一个角色聊上几句，这里会显示每一轮的实际消耗。</p>
        </header>
        <Empty
          title="还没有可统计的对话"
          hint="消耗是按会话统计的。开始一段对话后回来，就能看到携带量、召回条数这些旋钮对成本的影响。"
          action={<Link to="/" className="btn btn-primary">去找一个角色</Link>}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>成本</h1>
        <p className="muted">
          这里调的是"每轮花多少"。调低携带量与召回条数会省额度，
          代价是角色对久远事情记得少一点 —— 但更早的内容仍会走记忆检索捞回来。
        </p>
      </header>
      <CostPanel sessionId={sessionId} />
    </div>
  );
}
