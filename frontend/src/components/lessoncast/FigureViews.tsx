/**
 * 参数化图示。
 *
 * 为什么不让 AI 直接吐 SVG：教学图要的是「关系准确」，不是「画得好看」。
 * AI 给的坐标靠猜，中文会挤压、箭头会穿框；交给参数化组件后，坐标由我们算，
 * 文字永不溢出，还能跟着画面主题变色。SVG 只作为最后手段保留一个分支（已净化）。
 */
import { Fragment } from 'react';
import type { CastFigure } from '../../api/lessonCast';

function Caption({ fig }: { fig: CastFigure }) {
  return fig.caption ? <div className="lc-fig-cap">{fig.caption}</div> : null;
}

/**
 * 流程：2~4 步，节点用 `flex:0 1 auto` 紧排、箭头作为独立元素夹在中间。
 * 早先的做法是每步 `flex:1` 均分、箭头画在各自边缘 —— 步宽一大，箭头就悬空成一根破折号。
 */
function FlowView({ fig }: { fig: CastFigure }) {
  const steps = fig.steps || [];
  const vertical = fig.direction === 'v';
  return (
    <div className={`lc-fig-flow${vertical ? ' is-v' : ''}`}>
      {steps.map((s, i) => (
        <Fragment key={i}>
          {i > 0 ? <span className="lc-fig-arrow" aria-hidden="true" /> : null}
          <div className="lc-fig-step">
            <div className="lc-fig-pill">
              <span className="idx">{i + 1}</span>
              <span className="lb">{s.label}</span>
            </div>
            {s.note ? <div className="lc-fig-note">{s.note}</div> : null}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** 条形对比：按绝对值归一到最大值，避免"柱子画到框外" */
function BarsView({ fig }: { fig: CastFigure }) {
  const items = fig.items || [];
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  return (
    <div className="lc-fig-bars">
      {items.map((it, i) => (
        <div className="lc-fig-bar" key={i}>
          <span className="lb" title={it.label}>{it.label}</span>
          <div className="track">
            <i style={{ width: `${Math.max(6, (Math.abs(it.value) / max) * 100)}%` }} />
          </div>
          <span className="vl">
            {it.value}{fig.unit || ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 分类树：一个父项 + 2~4 个分支，连线用 CSS 画 */
function TreeView({ fig }: { fig: CastFigure }) {
  const kids = fig.children || [];
  return (
    <div className="lc-fig-tree">
      <div className="lc-fig-root">{fig.root}</div>
      <div className="lc-fig-kids">
        {kids.map((c, i) => (
          <div className="lc-fig-kid" key={i}>
            <span className="lb">{c.label}</span>
            {c.note ? <span className="nt">{c.note}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 模型直出的 SVG：**后端已 sanitize_svg + is_usable_svg 校验**，这里只负责塞进 DOM */
function SvgView({ fig }: { fig: CastFigure }) {
  if (!fig.svg) return null;
  return (
    <div
      className="lc-fig-svg"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: fig.svg }}
    />
  );
}

export function FigureView({ fig }: { fig: CastFigure }) {
  return (
    <div className="lc-fig">
      {fig.kind === 'flow' ? <FlowView fig={fig} />
        : fig.kind === 'bars' ? <BarsView fig={fig} />
          : fig.kind === 'tree' ? <TreeView fig={fig} />
            : <SvgView fig={fig} />}
      <Caption fig={fig} />
    </div>
  );
}
