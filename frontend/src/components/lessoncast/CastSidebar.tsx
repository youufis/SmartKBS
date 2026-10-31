/** 右栏课程目录：同课程的章节树，当前知识点高亮，已学打勾。 */
export interface SideItem {
  id: number;
  name: string;
  done?: boolean;
}

export interface SideGroup {
  title: string;
  items: SideItem[];
}

interface CastSidebarProps {
  groups: SideGroup[];
  currentKpId: number;
  pageTotal: number;
  minutes: number;
  onPick: (kpId: number) => void;
}

export function CastSidebar({ groups, currentKpId, pageTotal, minutes, onPick }: CastSidebarProps) {
  return (
    <aside className="lc-side">
      <h3>课程目录</h3>
      {groups.length === 0 ? (
        <div className="lc-tree-group">暂无同课程的知识点</div>
      ) : groups.map((g) => (
        <div key={g.title}>
          <div className="lc-tree-group">{g.title}</div>
          {g.items.map((it) => {
            const on = it.id === currentKpId;
            return (
              <div
                key={it.id}
                className={`lc-tree-item${on ? ' on' : ''}${it.done && !on ? ' done' : ''}`}
                onClick={() => { if (!on) onPick(it.id); }}
                title={it.name}
              >
                <span className="mk">{it.done && !on ? '✓' : on ? '▶' : '·'}</span>
                <span className="nm">{it.name}</span>
              </div>
            );
          })}
        </div>
      ))}
      <div className="lc-side-meta">
        <span>共 <b>{pageTotal}</b> 页</span>
        <span>约 <b>{minutes}</b> 分钟</span>
      </div>
    </aside>
  );
}
