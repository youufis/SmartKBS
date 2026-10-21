import { Button, InputNumber, Modal, Space } from 'antd'
import { useTranslation } from 'react-i18next'
import type { LadderQuestion } from '../../../api/classLadder'
import { optionKey, optionText } from '../utils'
import type { LadderLfModal, LadderVotePanel } from '../types'

interface Props {
  mode: 'light' | 'dark'
  lfModal: LadderLfModal | null
  onCloseLf: () => void
  votePanel: LadderVotePanel | null
  currentQ: LadderQuestion | null
  busy: boolean
  onVoteChange: (p: LadderVotePanel | null) => void
  onVoteSubmit: () => void
}

/** 锦囊弹窗（远程连线建议 / 投票分布）+ 现场表决录入面板 */
export default function LadderLifelineModals(p: Props) {
  const { t } = useTranslation('classLadder')
  const { mode, lfModal, votePanel, currentQ } = p
  return (
    <>
      {/* ── 锦囊结果 ── */}
      <Modal
        open={Boolean(lfModal)} onCancel={p.onCloseLf} footer={null}
        title={lfModal?.type === 'phone_friend' ? t('lifelineAdviceTitle') : t('lifelineVoteTitle')}
      >
        {lfModal?.type === 'phone_friend' && <div style={{ fontSize: 18 }}>💬 “{lfModal.advice}”</div>}
        {(lfModal?.type === 'audience_vote' || lfModal?.type === 'class_vote') && lfModal.votes && (
          <Space orientation="vertical" style={{ width: '100%' }}>
            {Object.entries(lfModal.votes).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <b style={{ width: 20 }}>{k}</b>
                <div style={{ flex: 1, height: 20, borderRadius: 10, overflow: 'hidden',
                  background: mode === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(24,48,100,0.08)' }}>
                  <div style={{ width: `${v}%`, height: '100%', background: 'linear-gradient(90deg,#4fc3f7,#7c4dff)' }} />
                </div>
                <span style={{ width: 48, textAlign: 'right' }}>{v}%</span>
              </div>
            ))}
          </Space>
        )}
        <div style={{ textAlign: 'right', marginTop: 16 }}>
          <Button type="primary" onClick={p.onCloseLf}>{t('lifelineOk')}</Button>
        </div>
      </Modal>

      {/* ── 现场表决：录入举手人数 ── */}
      <Modal open={Boolean(votePanel)} onCancel={() => p.onVoteChange(null)} footer={null}
        mask={{ closable: false }} title={t('voteTitle')}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>{t('voteHint')}</div>
        {votePanel && (currentQ?.options || []).map((o, i) => {
          const k = optionKey(o, i, currentQ?.type || 'single')
          return (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <b style={{ width: 22 }}>{k}</b>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {optionText(o, currentQ?.type || 'single')}
              </span>
              <InputNumber min={0} value={votePanel[k] ?? 0} style={{ width: 96 }}
                onChange={(v) => p.onVoteChange({ ...(votePanel || {}), [k]: Number(v || 0) })} />
            </div>
          )
        })}
        {votePanel && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 6 }}>
            {t('voteTotal', { n: Object.values(votePanel).reduce((x, y) => x + y, 0) })}
          </div>
        )}
        <div style={{ textAlign: 'right', marginTop: 16 }}>
          <Space>
            <Button onClick={() => p.onVoteChange(null)}>{t('lifelineOk')}</Button>
            <Button type="primary" loading={p.busy} onClick={p.onVoteSubmit}>{t('voteSubmit')}</Button>
          </Space>
        </div>
      </Modal>
    </>
  )
}
