/**
 * 讲演播放引擎（时间轴）。
 *
 * 移植自 backend/podcast_service.py 里内联播放器那套已验证的逻辑：
 * 单 audio 元素顺序播放、starts 累计定位、ended 时用真实 duration 校正后续起点。
 * 那块代码里最容易漏掉的一步是「校正」——不校正的话预估时长有几 % 误差，
 * 进度条会越走越偏，跳到后面几页时能差出好几秒。
 *
 * 本 hook **不认识 speaker_mode**：不管是单主讲还是双主播，它只处理「段 → 页」的映射。
 * 这是两种风格共用一套播放器的前提。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CastDetail, CastSegment } from '../api/lessonCast';

export interface TimelineSeg extends CastSegment {
  page: number;
}

export interface CastPlayerOptions {
  /** 断点续播：段下标优先于页下标 */
  startAt?: { page?: number; seg?: number; pos?: number };
  onPageChange?: (page: number) => void;
  onEnded?: () => void;
}

export interface CastPlayerApi {
  segs: TimelineSeg[];
  total: number;
  page: number;
  segIdx: number;
  playing: boolean;
  buffering: boolean;
  ended: boolean;
  /** 全局已播秒数（starts[idx] + 段内进度） */
  elapsed: number;
  /** 当前段内进度（断点上报用） */
  position: number;
  speed: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (v: number) => void;
  gotoPage: (page: number) => void;
  goPrevPage: () => void;
  goNextPage: () => void;
  seekToRatio: (ratio: number) => void;
  seekToTime: (seconds: number) => void;
}

const SPEEDS = [1, 1.5, 2];

export function useCastPlayer(cast: CastDetail | null | undefined,
                              options: CastPlayerOptions = {}): CastPlayerApi {
  const segs = useMemo<TimelineSeg[]>(() => {
    if (!cast?.pages?.length) return [];
    return cast.pages.flatMap((p, pi) =>
      (p.audio || []).map((a) => ({ ...a, page: pi })));
  }, [cast]);

  const [idx, setIdx] = useState(0);
  const [page, setPage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [ended, setEnded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [position, setPosition] = useState(0);
  const [speed, setSpeedState] = useState(1);
  const [total, setTotal] = useState(0);
  // audio 元素是第二个 effect 才建的，而建轴在第一个 effect 里就要用到它。
  // 用这个开关让建轴逻辑等音频对象就绪后再跑（StrictMode 双挂载下也成立）。
  const [audioReady, setAudioReady] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segsRef = useRef<TimelineSeg[]>([]);
  const startsRef = useRef<number[]>([]);
  const idxRef = useRef(0);
  const speedRef = useRef(1);
  const pendingSeekRef = useRef(-1);
  const pageRef = useRef(-1);
  const preloadedRef = useRef<Set<string>>(new Set());
  const optsRef = useRef(options);
  optsRef.current = options;

  /** 用时长数组重算每个段的全局起点 */
  const rebuildStarts = useCallback(() => {
    const list: number[] = [];
    let acc = 0;
    for (const s of segsRef.current) {
      list.push(acc);
      acc += Number(s.seconds) || 0;
    }
    startsRef.current = list;
    setTotal(acc);
  }, []);

  /** 预取当前页与下一页的音频：课堂上"下一页卡半秒"是最刺眼的体验事故 */
  const preloadFrom = useCallback((from: number) => {
    const list = segsRef.current;
    const cur = list[from]?.page;
    if (cur === undefined) return;
    for (let j = from; j < list.length && list[j].page <= cur + 1; j++) {
      const url = list[j].url;
      if (!url || preloadedRef.current.has(url)) continue;
      preloadedRef.current.add(url);
      try {
        const a = new Audio();
        a.preload = 'auto';
        a.src = url;
      } catch { /* 预取失败不影响主流程 */ }
    }
  }, []);

  const paint = useCallback(() => {
    const audio = audioRef.current;
    const cur = Number(audio?.currentTime) || 0;
    const base = startsRef.current[idxRef.current] ?? 0;
    setElapsed(base + cur);
    setPosition(cur);
    const seg = segsRef.current[idxRef.current];
    if (seg && seg.page !== pageRef.current) {
      pageRef.current = seg.page;
      setPage(seg.page);
      optsRef.current.onPageChange?.(seg.page);
    }
  }, []);

  const load = useCallback((next: number, autoplay: boolean, seek = -1) => {
    const audio = audioRef.current;
    const list = segsRef.current;
    if (!audio || !list.length) return;
    const i = Math.max(0, Math.min(list.length - 1, next));
    idxRef.current = i;
    setIdx(i);
    pendingSeekRef.current = seek;
    audio.src = list[i].url;
    audio.playbackRate = speedRef.current;
    setEnded(false);
    paint();
    preloadFrom(i);
    if (autoplay) {
      void audio.play().catch(() => setPlaying(false));
    }
  }, [paint, preloadFrom]);

  // 建立/重建时间轴（换讲演、换风格、换音频都走这里）
  useEffect(() => {
    if (!audioReady) return;
    segsRef.current = segs;
    pageRef.current = -1;
    preloadedRef.current = new Set();
    rebuildStarts();

    if (!segs.length) {
      setIdx(0);
      setElapsed(0);
      setTotal(0);
      setPlaying(false);
      return;
    }

    const startAt = optsRef.current.startAt;
    let begin = 0;
    if (startAt?.seg !== undefined && startAt.seg >= 0 && startAt.seg < segs.length) {
      begin = startAt.seg;
    } else if (startAt?.page !== undefined && startAt.page > 0) {
      const found = segs.findIndex((s) => s.page === startAt.page);
      if (found >= 0) begin = found;
    }
    idxRef.current = begin;
    setIdx(begin);
    const startPos = startAt?.pos && startAt.pos > 0 ? startAt.pos : -1;
    load(begin, false, startPos);
  }, [segs, rebuildStarts, load, audioReady]);

  // 音频元素（只建一次）
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;
    setAudioReady(true);

    const onMeta = () => paint();
    const onTime = () => paint();
    const onPlay = () => { setPlaying(true); setEnded(false); };
    const onPause = () => setPlaying(false);
    const onWaiting = () => setBuffering(true);
    const onPlayable = () => setBuffering(false);
    const onEnded = () => {
      // 用真实时长校正这一段（预估值差几 %，逐段校正避免累积漂移）
      const list = segsRef.current;
      const i = idxRef.current;
      if (list[i] && isFinite(audio.duration) && audio.duration > 0) {
        const diff = audio.duration - list[i].seconds;
        if (Math.abs(diff) > 0.01) {
          list[i].seconds = audio.duration;
          for (let j = i + 1; j < startsRef.current.length; j++) {
            startsRef.current[j] += diff;
          }
          setTotal((prev) => prev + diff);
        }
      }
      if (i + 1 < list.length) {
        load(i + 1, true);
      } else {
        setPlaying(false);
        setEnded(true);
        const base = startsRef.current[i] ?? 0;
        setElapsed(base + (Number(audio.duration) || list[i]?.seconds || 0));
        optsRef.current.onEnded?.();
      }
    };

    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('stalled', onWaiting);
    audio.addEventListener('canplay', onPlayable);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('stalled', onWaiting);
      audio.removeEventListener('canplay', onPlayable);
      audio.removeEventListener('ended', onEnded);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
      setPlaying(false);
      setAudioReady(false);
    };
  }, [load, paint]);

  // 真正的 seek 要等 metadata 到手才有 duration
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handler = () => {
      const target = pendingSeekRef.current;
      if (target >= 0 && isFinite(audio.duration) && audio.duration > 0) {
        pendingSeekRef.current = -1;
        try { audio.currentTime = Math.min(target, audio.duration - 0.05); } catch { /* 忽略 */ }
        paint();
      }
    };
    audio.addEventListener('loadedmetadata', handler);
    return () => audio.removeEventListener('loadedmetadata', handler);
  }, [paint]);

  const play = useCallback(() => {
    const audio = audioRef.current;
    const list = segsRef.current;
    if (!audio || !list.length) return;
    if (ended) {
      load(0, true);
      return;
    }
    void audio.play().catch(() => setPlaying(false));
  }, [ended, load]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [playing, pause, play]);

  const setSpeed = useCallback((v: number) => {
    const next = SPEEDS.includes(v) ? v : 1;
    speedRef.current = next;
    setSpeedState(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }, []);

  const gotoPage = useCallback((target: number) => {
    const found = segsRef.current.findIndex((s) => s.page === target);
    if (found < 0) return;
    const wasPlaying = !audioRef.current?.paused;
    load(found, wasPlaying);
  }, [load]);

  const goPrevPage = useCallback(() => {
    const cur = segsRef.current[idxRef.current]?.page ?? 0;
    gotoPage(Math.max(0, cur - 1));
  }, [gotoPage]);

  const goNextPage = useCallback(() => {
    const cur = segsRef.current[idxRef.current]?.page ?? 0;
    const last = segsRef.current[segsRef.current.length - 1]?.page ?? 0;
    gotoPage(Math.min(last, cur + 1));
  }, [gotoPage]);

  const seekToTime = useCallback((seconds: number) => {
    const starts = startsRef.current;
    if (!starts.length) return;
    const target = Math.max(0, Math.min(total - 0.05, seconds));
    let i = 0;
    while (i < starts.length - 1 && target >= starts[i + 1]) i++;
    const wasPlaying = !audioRef.current?.paused;
    load(i, wasPlaying, Math.max(0, target - starts[i]));
  }, [load, total]);

  const seekToRatio = useCallback((ratio: number) => {
    seekToTime(Math.max(0, Math.min(1, ratio)) * total);
  }, [seekToTime, total]);

  return {
    segs, total, page, segIdx: idx, playing, buffering, ended,
    elapsed, position, speed,
    play, pause, toggle, setSpeed,
    gotoPage, goPrevPage, goNextPage, seekToRatio, seekToTime,
  };
}
