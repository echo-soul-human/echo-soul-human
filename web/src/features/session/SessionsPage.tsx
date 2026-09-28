/**
 * SessionsPage.tsx — 「消息」页
 *
 * SessionList 本身是侧栏组件（会话项点击后自己 navigate），
 * 这里只补页面级的外壳：标题、空态处理、以及"造一个角色"的入口。
 * 不重复实现列表逻辑。
 */
import { Link } from '@tanstack/react-router';
import { SessionList } from './SessionList';

export function SessionsPage() {
  return (
    <div className="page page-sessions">
      <header className="page-head">
        <h1>消息</h1>
        <p className="muted">
          会记住你们说过的话。点击继续，或长按会话项改名、置顶、归档。
        </p>
      </header>

      <div className="sessions-host">
        <SessionList />
      </div>

      <footer className="page-foot muted">
        找不到想聊的？<Link to="/" className="link">去角色页</Link>挑一个，
        或者在<Link to="/" className="link">那里</Link>三句话造一个。
      </footer>
    </div>
  );
}
