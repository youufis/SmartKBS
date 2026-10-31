/**
 * AI 讲演播放页（学生「讲解模式」/ 教师「演示模式」共用）。
 *
 * 对标课程学习页：舞台 + 右栏目录 + 底部资料 + 句级字幕。
 * 两个场景的差别只在壳：`?present=1` 收起目录与资料、放大画面、开键盘控制并默认取单主讲版。
 *
 * 未设练习门禁：进度只用于展示与统计，随时可以跳走（方案 §15 第 5 条）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getCurriculumTree, getKpResources } from '../api/curriculum';
import {
  getCast,
  saveCastProgress,
  type CastDetail,
  type GetCastResult,
  type SpeakerMode,
} from '../api/lessonCast';
import { CastSidebar, type SideGroup } from '../components/lessoncast/CastSidebar';
import { CastStage } from '../components/lessoncast/CastStage';
import { MaterialsBar } from '../components/lessoncast/MaterialsBar';
import { PlayerBar } from '../components/lessoncast/PlayerBar';
import { SubtitleBar } from '../components/lessoncast/SubtitleBar';
import { useCastPlayer } from '../hooks/useCastPlayer';
import { useAuthStore } from '../stores/authStore';
import {
  CAST_THEMES, loadTheme, saveTheme, type CastTheme,
} from '../components/lessoncast/themes';
import type { ChapterTreeNode, Course, CurriculumResource } from '../types';
import '../components/lessoncast/lessoncast.css';

/** 完成判定：该页实际播放到 80% 才算学完（2 倍速刷过去的也算真听了） */
const PAGE_DONE_RATIO = 0.8;

interface FoundSpot {
  course: Course;
  chapterName: string;
  kpName: string;
  groups: SideGroup[];
  flat: { id: number; name: string }[];
}

function walkChapter(ch: ChapterTreeNode, trail: string[], out: SideGroup[],
                    flat: { id: number; name: string }[]) {
  const path = [...trail, ch.name];
  const kps = ch.knowledge_points || [];
  if (kps.length) {
    out.push({
      title: path.join(' / '),
      items: kps.map((k) => ({
        id: k.id,
        name: k.name,
        done: k.progress_status === 'completed',
      })),
    });
    kps.forEach((k) => flat.push({ id: k.id, name: k.name }));
  }
  (ch.children || []).forEach((c) => walkChapter(c, path, out, flat));
}

/** 在整棵树里定位这个知识点，并顺手组出右栏目录 */
function locate(tree: Course[], kpId: number): FoundSpot | null {
  for (const course of tree) {
    const groups: SideGroup[] = [];
    const flat: { id: number; name: string }[] = [];
    let chapterName = '';
    let kpName = '';
    const visit = (ch: ChapterTreeNode, trail: string[]) => {
      const path = [...trail, ch.name];
      (ch.knowledge_points || []).forEach((k) => {
        if (k.id === kpId) {
          kpName = k.name;
          chapterName = path.join(' / ');
        }
      });
      (ch.children || []).forEach((c) => visit(c, path));
    };
    (course.chapters || []).forEach((ch) => visit(ch, []));
    if (!kpName) continue;
    (course.chapters || []).forEach((ch) => walkChapter(ch, [], groups, flat));
    return { course, chapterName, kpName, groups, flat };
  }
  return null;
}

const LessonCastPage: React.FC = () => {
  const { kpId: kpIdStr } = useParams<{ kpId: string }>();
  const kpId = Number(kpIdStr);
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isTeacher = user?.role === 'admin' || user?.role === 'teacher';

  const present = search.get('present') === '1';
  const modeQuery = search.get('mode') as SpeakerMode | null;
  // 演示模式默认取单主讲版（老师自己还要补充讲解，双主播会抢话）；讲解模式默认双主播
  const wantMode: SpeakerMode = modeQuery || (present ? 'single' : 'duo');

  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState('');
  const [data, setData] = useState<GetCastResult | null>(null);
  const [spot, setSpot] = useState<FoundSpot | null>(null);
  const [resources, setResources] = useState<CurriculumResource[]>([]);
  const [donePages, setDonePages] = useState<Set<number>>(new Set());
  const [showHint, setShowHint] = useState(false);
  // 画面主题：只影响幻灯片配色，记在本地（和播客页面的做法一致）
  const [theme, setTheme] = useState<CastTheme>(() => loadTheme());

  const changeTheme = useCallback((t: CastTheme) => {
    setTheme(t);
    saveTheme(t);
  }, []);

  const cast: CastDetail | null = data?.cast || null;

  // ── 取讲演 ──
  useEffect(() => {
    if (!kpId || Number.isNaN(kpId)) {
      setLoading(false);
      setErrMsg('知识点参数不正确');
      return;
    }
    let alive = true;
    setLoading(true);
    setErrMsg('');
    getCast(kpId, { mode: wantMode, includeDraft: isTeacher })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => {
        if (!alive) return;
        const d = e?.response?.data?.detail;
        setErrMsg(typeof d === 'string' ? d : '讲演加载失败');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [kpId, wantMode, isTeacher]);

  // ── 课程目录与课节资料（只放已绑定资源）──
  useEffect(() => {
    if (!kpId) return;
    let alive = true;
    Promise.all([
      getCurriculumTree().catch(() => [] as Course[]),
      getKpResources(kpId).catch(() => ({ resources: [] as CurriculumResource[], total: 0 })),
    ]).then(([tree, res]) => {
      if (!alive) return;
      setSpot(locate(tree, kpId));
      setResources(res.resources || []);
    });
    return () => { alive = false; };
  }, [kpId]);

  const startAt = useMemo(() => {
    const pb = data?.playback;
    if (!cast || !pb || pb.cast_id !== cast.id) return undefined;
    if (!pb.pos && !pb.seg_idx) return undefined;
    return { seg: pb.seg_idx, pos: pb.pos, page: pb.page_idx };
  }, [cast, data?.playback]);

  const player = useCastPlayer(cast, { startAt });

  // ── 逐页累计实际播放时长：页切换时判断上一页是否算学完 ──
  const playedRef = useRef<Record<number, number>>({});
  const lastElapsedRef = useRef(0);
  const prevPageRef = useRef(0);

  useEffect(() => {
    const delta = player.elapsed - lastElapsedRef.current;
    lastElapsedRef.current = player.elapsed;
    if (player.playing && delta > 0 && delta < 2) {
      playedRef.current[player.page] = (playedRef.current[player.page] || 0) + delta;
    }
  }, [player.elapsed, player.playing, player.page]);

  useEffect(() => {
    const prev = prevPageRef.current;
    if (player.page === prev) return;
    prevPageRef.current = player.page;
    if (!cast) return;
    const pageSelf = cast.pages[prev];
    const dur = (pageSelf?.audio || []).reduce((s, a) => s + (Number(a.seconds) || 0), 0);
    if (dur > 0 && (playedRef.current[prev] || 0) >= dur * PAGE_DONE_RATIO) {
      setDonePages((old) => (old.has(prev) ? old : new Set(old).add(prev)));
    }
  }, [player.page, cast]);

  // ── 断点上报（页变化或完成集变化时，5s 最小间隔）──
  const lastSaveRef = useRef(0);
  const stateRef = useRef({ page: 0, seg: 0, pos: 0, done: new Set<number>() });
  stateRef.current = { page: player.page, seg: player.segIdx, pos: player.position, done: donePages };

  const flushProgress = useCallback((force = false) => {
    if (!cast || !kpId) return;
    const now = Date.now();
    if (!force && now - lastSaveRef.current < 5000) return;
    lastSaveRef.current = now;
    const s = stateRef.current;
    void saveCastProgress({
      kp_id: kpId,
      cast_id: cast.id,
      page_idx: s.page,
      seg_idx: s.seg,
      pos: s.pos,
      done_pages: [...s.done],
    }).catch(() => { /* 进度上报失败不打扰学习 */ });
  }, [cast, kpId]);

  useEffect(() => {
    if (!cast) return;
    const timer = window.setTimeout(() => flushProgress(false), 400);
    return () => window.clearTimeout(timer);
  }, [cast, player.page, donePages, flushProgress]);

  // 离开页面时补一次，避免"看到第 7 页就走了"丢断点
  useEffect(() => () => { flushProgress(true); }, [flushProgress]);

  // ── 演示模式提示条 ──
  useEffect(() => {
    if (!present) return;
    setShowHint(true);
    const timer = window.setTimeout(() => setShowHint(false), 3800);
    return () => window.clearTimeout(timer);
  }, [present]);

  const togglePresent = useCallback(() => {
    if (!kpId) return;
    navigate(`/learn/${kpId}${present ? '' : '?present=1'}`, { replace: true });
  }, [kpId, navigate, present]);

  // ── 键盘：空格 / ←→ / F / B / Esc / 数字跳页 ──
  const playerRef = useRef(player);
  playerRef.current = player;

  // ── 演讲者视图联动：同源 BroadcastChannel，不经过服务端 ──
  const liveRef = useRef({ page: 0, segIdx: 0, elapsed: 0, total: 0, playing: false });
  liveRef.current = {
    page: player.page,
    segIdx: player.segIdx,
    elapsed: player.elapsed,
    total: player.total,
    playing: player.playing,
  };

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined' || !cast) return;
    const ch = new BroadcastChannel('smartkb-cast');
    ch.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'cmd') {
        const p = playerRef.current;
        if (msg.cmd === 'next') p.goNextPage();
        else if (msg.cmd === 'prev') p.goPrevPage();
        else if (msg.cmd === 'toggle') p.toggle();
      } else if (msg?.type === 'hello') {
        ch.postMessage({ type: 'state', ...liveRef.current });
      }
    };
    const push = () => ch.postMessage({ type: 'state', ...liveRef.current });
    push();
    const timer = window.setInterval(push, 1000);
    return () => {
      window.clearInterval(timer);
      ch.close();
    };
  }, [cast]);

  const openPresenter = useCallback(() => {
    if (!kpId) return;
    window.open(`/learn/${kpId}/presenter`, 'cast-presenter',
      'width=1040,height=780,menubar=no,toolbar=no');
  }, [kpId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const p = playerRef.current;
      if (e.code === 'Space') {
        e.preventDefault();
        p.toggle();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        p.goNextPage();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        p.goPrevPage();
      } else if (e.key === 'f' || e.key === 'F') {
        togglePresent();
      } else if (e.key === 'Escape') {
        if (present) togglePresent();
      } else if (/^[1-9]$/.test(e.key)) {
        p.gotoPage(Number(e.key) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [present, togglePresent]);

  // ── 派生值 ──
  const pageTicks = useMemo(() => {
    if (!cast || !player.total) return [];
    const out: number[] = [];
    let acc = 0;
    cast.pages.forEach((p) => {
      out.push(acc / player.total);
      acc += (p.audio || []).reduce((s, a) => s + (Number(a.seconds) || 0), 0);
    });
    return out;
  }, [cast, player.total]);

  const currentSeg = player.segs[player.segIdx];
  const prevSeg = player.segIdx > 0 ? player.segs[player.segIdx - 1] : undefined;
  const nameA = cast?.name_a || '老师';
  const nameB = cast?.name_b || '同学';
  const mode: SpeakerMode = cast?.speaker_mode || 'duo';

  const prevText = useMemo(() => {
    if (!prevSeg) return '';
    if (mode === 'single') return prevSeg.text;
    return `${prevSeg.speaker === 'B' ? nameB : nameA}：${prevSeg.text}`;
  }, [prevSeg, mode, nameA, nameB]);

  const nextKp = useMemo(() => {
    if (!spot) return null;
    const i = spot.flat.findIndex((x) => x.id === kpId);
    return i >= 0 && i + 1 < spot.flat.length ? spot.flat[i + 1] : null;
  }, [spot, kpId]);

  // ── 渲染 ──
  if (loading) {
    return (
      <div className="lc-app">
        <div className="lc-center"><div className="lc-empty"><h2>正在准备讲演…</h2></div></div>
      </div>
    );
  }

  if (errMsg) {
    return (
      <div className="lc-app">
        <div className="lc-center">
          <div className="lc-empty">
            <h2>没能打开这节讲演</h2>
            <p>{errMsg}</p>
            <button className="lc-btn primary" type="button" onClick={() => navigate('/curriculum')}>
              回到课程
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!data?.exists || !cast) {
    return (
      <div className="lc-app">
        <div className="lc-center">
          <div className="lc-empty">
            <h2>{spot?.kpName || '这个知识点'}还没有 AI 讲演</h2>
            <p>
              {isTeacher
                ? '到「课程管理」里为它生成一节讲演，学生就能像看微课一样学。'
                : '老师还没有为这个知识点准备讲演。你可以先看课节资料，或回到课程继续学习。'}
            </p>
            <button className="lc-btn primary" type="button" onClick={() => navigate('/curriculum')}>
              回到课程
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!player.segs.length) {
    return (
      <div className="lc-app">
        <div className="lc-center">
          <div className="lc-empty">
            <h2>这节讲演还没有声音</h2>
            <p>
              {isTeacher
                ? '大纲已经生成，但音频还没合成。回到课程页再点一次「AI 讲演」，确认大纲后合成音频。'
                : '老师还在准备这节的音频，稍后再来，或先看课节资料。'}
            </p>
            <button className="lc-btn primary" type="button" onClick={() => navigate('/curriculum')}>
              回到课程
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`lc-app${present ? ' is-present' : ''}`}>
      <header className="lc-top">
        <button className="lc-back" type="button" title="返回课程" onClick={() => navigate('/curriculum')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          <span className="lc-back-text">返回课程</span>
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="lc-title">
            {spot?.course.name || cast.title}
            {spot?.chapterName ? ` · ${spot.chapterName}` : ''}
          </div>
          <div className="lc-sub">
            <span>{spot?.kpName || cast.title}</span>
            <span>共 <b>{cast.pages.length}</b> 页</span>
            <span>约 <b>{Math.max(1, Math.round(player.total / 60))}</b> 分钟</span>
            {cast.fallback ? <span>（该讲法暂无，已用另一版）</span> : null}
            {cast.stale ? <span style={{ color: 'var(--warning-color)' }}>内容已更新，音频待重生成</span> : null}
          </div>
        </div>
        <div className="lc-grow" />
        <div className="lc-pillgroup">
          <button
            type="button"
            className={(modeQuery || (present ? 'single' : 'duo')) === 'duo' ? 'on' : ''}
            onClick={() => navigate(`/learn/${kpId}?mode=duo${present ? '&present=1' : ''}`)}
          >双主播</button>
          <button
            type="button"
            className={(modeQuery || (present ? 'single' : 'duo')) === 'single' ? 'on' : ''}
            onClick={() => navigate(`/learn/${kpId}?mode=single${present ? '&present=1' : ''}`)}
          >单主讲</button>
        </div>
        <div className="lc-themes" role="group" aria-label="画面主题">
          {CAST_THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`lc-theme-dot${theme === t.id ? ' on' : ''}`}
              style={{ background: t.dot }}
              title={`画面主题：${t.name}`}
              aria-label={t.name}
              onClick={() => changeTheme(t.id)}
            />
          ))}
        </div>
        {present ? (
          <button className="lc-ghost" type="button" onClick={openPresenter} title="放在老师自己的屏幕上，显示下一页与逐字稿">
            演讲者视图
          </button>
        ) : null}
        <button className="lc-ghost" type="button" onClick={togglePresent}>
          {present ? '退出演示' : '课堂演示'}
        </button>
      </header>

      <div className="lc-body">
        <main className="lc-main">
          <CastStage
            page={cast.pages[player.page]}
            pageIndex={player.page}
            pageTotal={cast.pages.length}
            speaker={currentSeg?.speaker || null}
            nameA={nameA}
            nameB={nameB}
            mode={mode}
            theme={theme}
          />

          <SubtitleBar
            prevText={prevText}
            text={currentSeg?.text}
            speaker={currentSeg?.speaker || 'A'}
            mode={mode}
            nameA={nameA}
            nameB={nameB}
          />

          <PlayerBar
            playing={player.playing}
            buffering={player.buffering}
            ended={player.ended}
            elapsed={player.elapsed}
            total={player.total}
            speed={player.speed}
            pageTicks={pageTicks}
            onToggle={player.toggle}
            onSpeed={player.setSpeed}
            onSeek={player.seekToRatio}
            onPrevPage={player.goPrevPage}
            onNextPage={player.goNextPage}
          />

          {player.ended ? (
            <div className="lc-finish">
              <div>
                <div className="t">这节讲完了</div>
                <div className="d">已学 {donePages.size} / {cast.pages.length} 页</div>
              </div>
              <div className="acts">
                {nextKp ? (
                  <button className="lc-btn primary" type="button"
                    onClick={() => navigate(`/learn/${nextKp.id}`)}>
                    下一个：{nextKp.name.length > 10 ? `${nextKp.name.slice(0, 10)}…` : nextKp.name}
                  </button>
                ) : null}
                <button className="lc-btn" type="button" onClick={() => navigate('/curriculum')}>
                  回到课程
                </button>
              </div>
            </div>
          ) : null}
        </main>

        <CastSidebar
          groups={spot?.groups || []}
          currentKpId={kpId}
          pageTotal={cast.pages.length}
          minutes={Math.max(1, Math.round(player.total / 60))}
          onPick={(id) => navigate(`/learn/${id}`)}
        />
      </div>

      <MaterialsBar resources={resources} />

      <div className={`lc-hint${showHint ? ' show' : ''}`}>
        <kbd>空格</kbd> 播放/暂停　<kbd>←</kbd><kbd>→</kbd> 翻页　<kbd>F</kbd> 退出演示　
        <kbd>1</kbd>~<kbd>9</kbd> 跳页
      </div>
    </div>
  );
};

export default LessonCastPage;
