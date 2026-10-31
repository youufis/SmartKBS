/**
 * 大纲编辑器：改页标题、逐句改台词、调整页序、删页、加句。
 *
 * 只改"讲什么"（标题与台词），不改画面版式（points/steps 等仍由 AI 给的）。
 * 这样能让老师纠正口误、调整例子，又不会把版式结构改坏。
 *
 * 一句台词 = 一个字幕单元 = 一次 TTS，所以编辑器里把 60 字作为提示线：
 * 超了不拦（TTS 上限 200 字），但字幕会太长。
 */
import { useState } from 'react';
import { Button, Empty, Input, Tooltip } from 'antd';
import type { CastPage, SpeakerMode } from '../../api/lessonCast';

interface OutlineEditorProps {
  pages: CastPage[];
  onChange: (pages: CastPage[]) => void;
  hasAudio: boolean;
  /** 正在重合成的页下标（按钮转圈） */
  regenPageIdx: number | null;
  onRegenPage?: (idx: number) => void;
  mode: SpeakerMode;
  nameA: string;
  nameB: string;
}

const LAYOUT_LABEL: Record<string, string> = {
  cover: '封面', bullets: '要点', compare: '对比', steps: '步骤',
  cards: '卡片', figure: '配图', formula: '公式', summary: '小结',
};

const FIGURE_LABEL: Record<string, string> = {
  flow: '流程', bars: '对比', tree: '分类', svg: '示意图',
};

/** 一句台词建议长度：超过就不像"一句话"，字幕会分两行 */
const SOFT_LIMIT = 60;

export function OutlineEditor({
  pages, onChange, hasAudio, regenPageIdx, onRegenPage, mode, nameA, nameB,
}: OutlineEditorProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  const patchPage = (i: number, patch: Partial<CastPage>) => {
    onChange(pages.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  };

  const patchLine = (pi: number, li: number, patch: { speaker?: 'A' | 'B'; text?: string }) => {
    const lines = (pages[pi].lines || []).map((ln, j) => (j === li ? { ...ln, ...patch } : ln));
    patchPage(pi, { lines });
  };

  const removeLine = (pi: number, li: number) => {
    patchPage(pi, { lines: (pages[pi].lines || []).filter((_, j) => j !== li) });
  };

  const addLine = (pi: number) => {
    patchPage(pi, { lines: [...(pages[pi].lines || []), { speaker: 'A', text: '' }] });
  };

  const movePage = (i: number, delta: -1 | 1) => {
    const t = i + delta;
    if (t < 0 || t >= pages.length) return;
    const next = [...pages];
    [next[i], next[t]] = [next[t], next[i]];
    onChange(next);
    setOpenIdx(t);
  };

  const removePage = (i: number) => {
    if (pages.length <= 1) return;
    onChange(pages.filter((_, j) => j !== i));
    setOpenIdx(null);
  };

  if (!pages.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有页面" />;
  }

  return (
    <div className="lc-editor">
      {pages.map((p, i) => {
        const open = openIdx === i;
        const lines = p.lines || [];
        return (
          <div className="lc-editor-page" key={i}>
            <div className="lc-editor-head">
              <button
                type="button"
                className="lc-editor-toggle"
                onClick={() => setOpenIdx(open ? null : i)}
                title={open ? '收起' : '展开'}
              >
                {open ? '▾' : '▸'}
              </button>
              <span className="lc-editor-idx">{i + 1}</span>
              <span className="lc-editor-tag">{LAYOUT_LABEL[p.layout] || p.layout}</span>
              {p.figure ? (
                <span className="lc-editor-tag is-fig">图·{FIGURE_LABEL[p.figure.kind] || p.figure.kind}</span>
              ) : null}
              {p.formula ? <span className="lc-editor-tag is-fig">含公式</span> : null}
              <Input
                size="small"
                value={p.title}
                maxLength={30}
                onChange={(e) => patchPage(i, { title: e.target.value })}
                style={{ flex: 1, minWidth: 0 }}
              />
              <span className="lc-editor-count">{lines.length} 句</span>
              <Tooltip title="上移">
                <button type="button" className="lc-editor-mini" disabled={i === 0}
                  onClick={() => movePage(i, -1)}>↑</button>
              </Tooltip>
              <Tooltip title="下移">
                <button type="button" className="lc-editor-mini" disabled={i === pages.length - 1}
                  onClick={() => movePage(i, 1)}>↓</button>
              </Tooltip>
              <Tooltip title="删除这一页">
                <button type="button" className="lc-editor-mini danger"
                  disabled={pages.length <= 1} onClick={() => removePage(i)}>✕</button>
              </Tooltip>
            </div>

            {open ? (
              <div className="lc-editor-body">
                {lines.map((ln, li) => {
                  const long = ln.text.length > SOFT_LIMIT;
                  return (
                    <div className="lc-editor-line" key={li}>
                      {mode === 'duo' ? (
                        <button
                          type="button"
                          className={`lc-editor-spk${ln.speaker === 'B' ? ' is-b' : ''}`}
                          title="切换说话人"
                          onClick={() => patchLine(i, li, { speaker: ln.speaker === 'B' ? 'A' : 'B' })}
                        >
                          {ln.speaker === 'B' ? (nameB || 'B') : (nameA || 'A')}
                        </button>
                      ) : (
                        <span className="lc-editor-spk is-static">{nameA || 'A'}</span>
                      )}
                      <Input.TextArea
                        value={ln.text}
                        autoSize={{ minRows: 1, maxRows: 4 }}
                        maxLength={200}
                        placeholder="这一句要讲的话"
                        onChange={(e) => patchLine(i, li, { text: e.target.value })}
                        status={long ? 'warning' : undefined}
                      />
                      {ln.warn ? (
                        <Tooltip title="原文含公式符号，已自动转成口语，建议改写成更自然的说法">
                          <span className="lc-editor-warn">!</span>
                        </Tooltip>
                      ) : null}
                      <span className={`lc-editor-len${long ? ' over' : ''}`}>{ln.text.length}</span>
                      <Tooltip title="删除这一句">
                        <button type="button" className="lc-editor-mini danger"
                          onClick={() => removeLine(i, li)}>✕</button>
                      </Tooltip>
                    </div>
                  );
                })}

                <div className="lc-editor-actions">
                  <Button size="small" type="dashed" onClick={() => addLine(i)}>+ 加一句</Button>
                  {hasAudio && onRegenPage ? (
                    <Button
                      size="small"
                      loading={regenPageIdx === i}
                      onClick={() => onRegenPage(i)}
                    >
                      仅重合成这一页
                    </Button>
                  ) : null}
                  <span className="lc-editor-tip">
                    改完记得保存；只改这一页时用"仅重合成这一页"能省掉整篇的合成费用。
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
