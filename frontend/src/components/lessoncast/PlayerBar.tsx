/** 播放控制条：播放/暂停、进度（带页点）、倍速、翻页。 */
interface PlayerBarProps {
  playing: boolean;
  buffering: boolean;
  ended: boolean;
  elapsed: number;
  total: number;
  speed: number;
  /** 每页起点占总时长的比例，用于进度条上的页点 */
  pageTicks: number[];
  onToggle: () => void;
  onSpeed: (v: number) => void;
  onSeek: (ratio: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
}

const SPEEDS = [1, 1.5, 2];

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function PlayerBar({
  playing, buffering, ended, elapsed, total, speed, pageTicks,
  onToggle, onSpeed, onSeek, onPrevPage, onNextPage,
}: PlayerBarProps) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 0;

  return (
    <div className="lc-ctrl">
      <button className="lc-pbtn" onClick={onToggle} title={playing ? '暂停' : '播放'} type="button">
        {buffering ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
        ) : playing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        )}
      </button>

      <span className="lc-time">{fmt(elapsed)}</span>

      <div
        className="lc-barwrap"
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek((e.clientX - rect.left) / rect.width);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') onSeek(Math.min(1, ratio + 0.02));
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, ratio - 0.02));
        }}
      >
        <div className="lc-bar"><i style={{ width: `${ratio * 100}%` }} /></div>
        <div className="lc-ticks">
          {pageTicks.map((t, i) => (
            <span key={i} style={{ left: `${t * 100}%` }} />
          ))}
        </div>
      </div>

      <span className="lc-time">{fmt(total)}</span>

      <div className="lc-rates">
        {SPEEDS.map((v) => (
          <button key={v} type="button" className={speed === v ? 'on' : ''} onClick={() => onSpeed(v)}>
            {v}x
          </button>
        ))}
      </div>

      <button className="lc-navbtn" onClick={onPrevPage} title="上一页" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <button className="lc-navbtn" onClick={onNextPage} title="下一页" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
      </button>
      {ended ? <span className="lc-time">已播完</span> : null}
    </div>
  );
}
