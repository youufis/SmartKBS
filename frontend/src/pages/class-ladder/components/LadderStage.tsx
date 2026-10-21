import { Empty } from 'antd'
import { BulbOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { LadderQuestion } from '../../../api/classLadder'
import FormulaRenderer from '../../../components/FormulaRenderer'
import MediaDisplay from '../../../components/MediaDisplay'
import { optionKey, optionText } from '../utils'
import type { LadderReveal } from '../types'

interface Props {
  currentQ: LadderQuestion | null
  selected: number | null
  reveal: LadderReveal | null
  hiddenKeys: string[]
  busy: boolean
  onSelect: (i: number) => void
}

/** 舞台题卡：题干 + 媒体 + 选项（选中/去伪/对错态） + 底部提示行 */
export default function LadderStage({ currentQ, selected, reveal, hiddenKeys, busy, onSelect }: Props) {
  const { t } = useTranslation('classLadder')
  return (
    <section className="cl-stage">
      <div className="cl-qcard">
        {currentQ ? (
          <>
            <div className="cl-qmeta">
              <span className="cl-pill"><BulbOutlined /> {currentQ.type === 'true_false' ? t('qtTrueFalse') : t('qtSingle')} · {currentQ.source === 'ai' ? t('sourceAi') : t('sourceBank')}</span>
              <span className="cl-pill point">{t('levelLabel', { n: currentQ.level })} · {currentQ.score} {t('scoreUnit')}</span>
              <span className="cl-pill">{t('difficulty')}：{currentQ.difficulty === 'easy' ? t('diffEasy') : currentQ.difficulty === 'hard' ? t('diffHard') : t('diffMedium')}</span>
            </div>
            <div className="cl-stem"><FormulaRenderer content={currentQ.question} /></div>
            <MediaDisplay svgContent={currentQ.svg_content} hasSvg={currentQ.has_svg}
              mediaFiles={currentQ.media_files as never} size="large" />
            <div className="cl-opts">
              {(currentQ.options || []).map((opt, i) => {
                const key = optionKey(opt, i, currentQ.type)
                const gone = hiddenKeys.includes(key)
                const isRight = Boolean(reveal) && key === reveal?.answer
                const isWrong = Boolean(reveal) && selected === i && !reveal?.correct
                const cls = [gone ? ' gone' : '', selected === i && !reveal ? ' sel' : '',
                  isRight ? ' right' : '', isWrong ? ' wrong' : ''].join('')
                return (
                  <div key={i} className={`cl-opt${cls}`}
                    onClick={() => { if (!gone && !reveal && !busy) onSelect(i) }}>
                    <span className="k">{key}</span>
                    <span className="txt"><FormulaRenderer content={optionText(opt, currentQ.type)} inline /></span>
                    {isRight && <span className="mark">✓</span>}
                  </div>
                )
              })}
            </div>
            <div className="cl-footline">
              {reveal ? (
                <>
                  <span>{t('answerIs')}：<b style={{ color: 'var(--cl-ok)' }}>{reveal.answer || '—'}</b></span>
                  {!reveal.correct && <span>· {t('incorrectTxt')}</span>}
                </>
              ) : (
                <span>{t('enterHint')}</span>
              )}
            </div>
          </>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('drawStudent')} style={{ margin: 'auto' }} />
        )}
      </div>
    </section>
  )
}
