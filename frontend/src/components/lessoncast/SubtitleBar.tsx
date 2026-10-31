/** 讲演字幕：上一句淡出、当前句高亮。单主讲不显示说话人标签。 */
import type { SpeakerMode } from '../../api/lessonCast';

interface SubtitleBarProps {
  /** 上一句（父组件已拼好"人名："前缀，这里只负责显示） */
  prevText?: string;
  text?: string;
  speaker: 'A' | 'B';
  mode: SpeakerMode;
  nameA: string;
  nameB: string;
}

export function SubtitleBar({ prevText, text, speaker, mode, nameA, nameB }: SubtitleBarProps) {
  const who = speaker === 'B' ? (nameB || '同学') : (nameA || '老师');
  return (
    <div className={`lc-subtitle${mode === 'single' ? ' is-single' : ''}`}>
      <div className="lc-sub-prev">{prevText || ''}</div>
      <div className="lc-sub-cur">
        <span className={`lc-sub-who${speaker === 'B' ? ' is-b' : ''}`}>{who}</span>
        <span className="lc-sub-text">{text || '　'}</span>
      </div>
    </div>
  );
}
