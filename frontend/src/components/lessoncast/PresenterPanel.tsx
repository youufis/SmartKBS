/**
 * 演讲者视图（第二屏）。
 *
 * 课堂投屏的真实姿势：投影给学生的屏幕只放画面，老师自己笔记本上看"下一页讲什么、
 * 逐字稿、讲了多久"。所以这个窗口不渲染舞台，只给小抄与控制。
 *
 * 与主窗用 BroadcastChannel 同源通信（不用服务端、不用 WebSocket）：
 *   主窗 → 这里：{type:'state', page, segIdx, elapsed, total, playing}
 *   这里 → 主窗：{type:'cmd', cmd:'next'|'prev'|'toggle'}
 */
import { useEffect, useRef, useState } from 'react';
import { getCast, type CastDetail, type GetCastResult, type SpeakerMode } from '../../api/lessonCast';

interface RemoteState {
  page: number;
  segIdx: number;
  elapsed: number;
  total: number;
  playing: boolean;
}

const CHANNEL = 'smartkb-cast';

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function PresenterPanel({ kpId, mode = 'single' }: { kpId: number; mode?: SpeakerMode }) {
  const [data, setData] = useState<GetCastResult | null>(null);
  const [state, setState] = useState<RemoteState | null>(null);
  const [connected, setConnected] = useState(false);
  const chRef = useRef<BroadcastChannel | null>(null);
  const lastMsgRef = useRef(0);

  const cast: CastDetail | null = data?.cast || null;

  useEffect(() => {
    let alive = true;
    getCast(kpId, { mode, includeDraft: true })
      .then((r) => { if (alive) setData(r); })
      .catch(() => { /* 未登录或无数据时留空态 */ });
    return () => { alive = false; };
  }, [kpId, mode]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL);
    chRef.current = ch;
    ch.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'state') {
        lastMsgRef.current = Date.now();
        setConnected(true);
        setState({
          page: Number(msg.page) || 0,
          segIdx: Number(msg.segIdx) || 0,
          elapsed: Number(msg.elapsed) || 0,
          total: Number(msg.total) || 0,
          playing: !!msg.playing,
        });
      }
    };
    // 主窗可能比本窗口早开：先问一声，再定期确认连接还活着
    ch.postMessage({ type: 'hello' });
    const hello = window.setInterval(() => ch.postMessage({ type: 'hello' }), 3000);
    const alive = window.setInterval(() => {
      if (Date.now() - lastMsgRef.current > 6000) setConnected(false);
    }, 2000);
    return () => {
      window.clearInterval(hello);
      window.clearInterval(alive);
      ch.close();
    };
  }, []);

  const send = (cmd: 'next' | 'prev' | 'toggle') => {
    chRef.current?.postMessage({ type: 'cmd', cmd });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') { e.preventDefault(); send('toggle'); }
      else if (e.key === 'ArrowRight') send('next');
      else if (e.key === 'ArrowLeft') send('prev');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pages = cast?.pages || [];
  const pageIdx = state?.page ?? 0;
  const page = pages[pageIdx];
  const nextPage = pages[pageIdx + 1];
  const currentSegIdx = state?.segIdx ?? -1;

  // 逐字稿：把全篇台词摊平后定位当前句，高亮它、上下文变淡
  const lines = (page?.lines || []);
  let localSeg = -1;
  if (currentSegIdx >= 0) {
    // state.segIdx 是全局段下标，换算成"本页第几句"
    let acc = 0;
    for (let i = 0; i < pageIdx; i++) acc += (pages[i]?.audio || []).length;
    localSeg = currentSegIdx - acc;
  }

  return (
    <div className="lc-presenter">
      <div className="lc-pr-top">
        <span className={`lc-pr-dot${connected ? ' on' : ''}`} />
        <span className="lc-pr-status">{connected ? '已连接主屏' : '等待主屏…（请在播放页打开演讲者视图）'}</span>
        <span className="lc-pr-clock">
          {state ? `${fmt(state.elapsed)} / ${fmt(state.total)}` : '--:-- / --:--'}
        </span>
        <span className="lc-pr-page">第 {pageIdx + 1} / {pages.length || '?'} 页</span>
        <div className="lc-pr-acts">
          <button type="button" onClick={() => send('prev')}>上一页</button>
          <button type="button" className="primary" onClick={() => send('toggle')}>
            {state?.playing ? '暂停' : '继续'}
          </button>
          <button type="button" onClick={() => send('next')}>下一页</button>
        </div>
      </div>

      <div className="lc-pr-body">
        <section className="lc-pr-now">
          <div className="lc-pr-label">正在讲</div>
          <div className="lc-pr-title">{page?.title || '（还没有数据）'}</div>
          <div className="lc-pr-script">
            {lines.length === 0 ? (
              <div className="lc-pr-empty">这一页没有台词</div>
            ) : lines.map((ln, i) => (
              <div key={i} className={`lc-pr-line${i === localSeg ? ' cur' : ''}`}>
                <span className={`lc-pr-who${ln.speaker === 'B' ? ' is-b' : ''}`}>
                  {ln.speaker === 'B' ? (cast?.name_b || 'B') : (cast?.name_a || 'A')}
                </span>
                <span>{ln.text}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="lc-pr-next">
          <div className="lc-pr-label">下一页</div>
          {nextPage ? (
            <>
              <div className="lc-pr-title small">{nextPage.title}</div>
              {(nextPage.points || []).length ? (
                <ul className="lc-pr-points">
                  {(nextPage.points || []).map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              ) : null}
              <div className="lc-pr-nextlines">
                {(nextPage.lines || []).slice(0, 2).map((ln, i) => (
                  <div key={i} className="lc-pr-nl">
                    <span className={`lc-pr-who${ln.speaker === 'B' ? ' is-b' : ''}`}>
                      {ln.speaker === 'B' ? (cast?.name_b || 'B') : (cast?.name_a || 'A')}
                    </span>
                    <span>{ln.text}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="lc-pr-empty">已经是最后一页</div>
          )}
        </section>
      </div>

      <div className="lc-pr-foot">
        <kbd>空格</kbd> 暂停/继续　<kbd>←</kbd><kbd>→</kbd> 翻页　·　本窗口请放在老师的屏幕上，别投出去
      </div>
    </div>
  );
}
