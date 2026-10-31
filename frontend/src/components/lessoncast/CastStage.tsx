/**
 * 讲演舞台：一页幻灯片 + 页码/说话人指示。
 *
 * 画面完全由这里的内置版式渲染，**不使用 AI 生成的 HTML** —— 否则无法翻页、
 * 无法定位到页、也无法单页重录。模型只提供 layout 枚举与字段。
 */
import { useEffect, useRef } from 'react';
import type { CastPage, SpeakerMode } from '../../api/lessonCast';
import FormulaRenderer from '../FormulaRenderer';
import { FigureView } from './FigureViews';
import type { CastTheme } from './themes';

/** 画面文字：含 $ 才走公式渲染，纯文本保持原样（避免给每行都套一层 Markdown） */
function RichText({ text }: { text: string }) {
  if (!text.includes('$')) return <>{text}</>;
  return (
    <span className="lc-rt">
      <FormulaRenderer content={text} inline />
    </span>
  );
}

interface CastStageProps {
  page?: CastPage;
  pageIndex: number;
  pageTotal: number;
  /** 当前在说话的人；单主讲恒为 A */
  speaker: 'A' | 'B' | null;
  nameA: string;
  nameB: string;
  mode: SpeakerMode;
  animate?: boolean;
  /** 画面配色主题（只影响幻灯片与页码胶囊，不动整站主题） */
  theme?: CastTheme;
}

function Bullets({ page }: { page: CastPage }) {
  const points = page.points || [];
  return (
    <>
      {page.kicker ? <div className="lc-s-kicker">{page.kicker}</div> : null}
      <div className="lc-s-h2">{page.title}</div>
      <div className="lc-s-body">
        {points.map((p, i) => {
          // 允许 "对人：满足需要" 这种"关键词：说明"的写法，渲染成两段层次
          const [key, ...rest] = p.split(/[：:]/);
          const dim = rest.join('：').trim();
          return (
            <div className="lc-s-item" key={i}>
              <span className="lc-s-num">{i + 1}</span>
              <div>
                <span className="lc-s-key"><RichText text={key} /></span>
                {dim ? <span className="lc-s-dim"><RichText text={dim} /></span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Compare({ page }: { page: CastPage }) {
  const sides = [
    { side: page.left, cls: '' },
    { side: page.right, cls: 'is-b' },
  ];
  return (
    <>
      <div className="lc-s-h2">{page.title}</div>
      <div className="lc-s-cols">
        {sides.map(({ side, cls }, i) => (
          <div className={`lc-s-col ${cls}`} key={i}>
            <div className="lc-s-col-h"><i />{side?.head || (i === 0 ? '一方面' : '另一方面')}</div>
            <ul>{((side?.items) || []).map((it, j) => <li key={j}><RichText text={it} /></li>)}</ul>
          </div>
        ))}
      </div>
    </>
  );
}

function Steps({ page }: { page: CastPage }) {
  const steps = page.steps || [];
  return (
    <>
      <div className="lc-s-h2">{page.title}</div>
      <div className="lc-s-steps">
        {steps.map((s, i) => (
          <div className="lc-s-step" key={i}>
            <div className="n">{s[0] || `第${i + 1}步`}</div>
            <div className="t">{s[1] || ''}</div>
            {s[2] ? <div className="d">{s[2]}</div> : null}
          </div>
        ))}
      </div>
    </>
  );
}

function Cards({ page }: { page: CastPage }) {
  const cards = page.cards || [];
  return (
    <>
      <div className="lc-s-h2">{page.title}</div>
      <div className="lc-s-cards"
        style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(cards.length, 1), 4)}, 1fr)` }}>
        {cards.map((c, i) => (
          <div className="lc-s-card" key={i}>
            <b>{c[0] || String(i + 1)}</b>
            {c[1] || ''}
          </div>
        ))}
      </div>
    </>
  );
}

/** 整页公式：交块级 KaTeX 渲染。语法错时 KaTeX 会输出 .katex-error（可见的红色原文），不会白屏 */
function FormulaPage({ page }: { page: CastPage }) {
  return (
    <>
      <div className="lc-s-h2">{page.title}</div>
      <div className="lc-s-formula">
        <FormulaRenderer content={`$$${page.formula || ''}$$`} />
      </div>
      {page.formulaNote ? <div className="lc-s-formula-note">{page.formulaNote}</div> : null}
    </>
  );
}

function Figure({ page }: { page: CastPage }) {
  return (
    <>
      <div className="lc-s-h2">{page.title}</div>
      {page.figure ? <FigureView fig={page.figure} /> : null}
      {!page.figure && page.image ? (
        <div className="lc-s-figure">
          <img src={page.image} alt={page.caption || page.title} />
          {page.caption ? <div className="cap">{page.caption}</div> : null}
        </div>
      ) : null}
      {!page.figure && !page.image ? (
        <div className="lc-s-figure">
          <div className="ph">此页建议配一张图</div>
          {page.caption ? <div className="cap">{page.caption}</div> : null}
        </div>
      ) : null}
    </>
  );
}

function LayoutBody({ page }: { page: CastPage }) {
  switch (page.layout) {
    case 'cover':
      return (
        <>
          <div className="lc-s-kicker">{page.kicker || 'AI 讲演'}</div>
          <div className="lc-s-h1">{page.title}</div>
          {page.subtitle ? <div className="lc-s-sub">{page.subtitle}</div> : null}
          <div className="lc-s-rule" />
        </>
      );
    case 'compare':
      return <Compare page={page} />;
    case 'steps':
      return <Steps page={page} />;
    case 'cards':
      return <Cards page={page} />;
    case 'formula':
      return <FormulaPage page={page} />;
    case 'figure':
      return <Figure page={page} />;
    case 'summary':
    case 'bullets':
    default:
      return <Bullets page={page} />;
  }
}

export function CastStage({
  page, pageIndex, pageTotal, speaker, nameA, nameB, mode, animate = true, theme = 'white',
}: CastStageProps) {
  const slideRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = slideRef.current;
    if (!el || !animate || typeof el.animate !== 'function') return;
    // 只用 transform 做进场：opacity 过渡在某些环境下会卡在中间帧，幻灯片会发灰
    el.animate([{ transform: 'translateY(7px)' }, { transform: 'none' }],
      { duration: 200, easing: 'ease-out' });
  }, [pageIndex, animate]);

  return (
    <div className="lc-stage-wrap" data-theme={theme}>
      <div className="lc-stage">
        <div className="lc-slide" ref={slideRef}>
          {page ? <LayoutBody page={page} /> : (
            <>
              <div className="lc-s-kicker">AI 讲演</div>
              <div className="lc-s-h1">这一页还没有内容</div>
              <div className="lc-s-sub">请老师回到课程页重新生成讲演</div>
            </>
          )}
        </div>
      </div>
      <div className="lc-hud">
        <span className="lc-pill">第 {Math.min(pageIndex + 1, pageTotal)} / {pageTotal} 页</span>
        {mode === 'duo' ? (
          <span className="lc-spk">
            <b className={speaker === 'A' ? 'on' : ''}><em>A</em>{nameA || '老师'}</b>
            <b className={`is-b${speaker === 'B' ? ' on' : ''}`}><em>B</em>{nameB || '同学'}</b>
          </span>
        ) : (
          <span className="lc-spk">
            <b className={speaker === 'A' ? 'on' : ''}><em>A</em>{nameA || '老师'}</b>
          </span>
        )}
      </div>
    </div>
  );
}
