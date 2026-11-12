// 本场战报弹窗：结束一场后展示红榜 + 每局逐关明细（后端 /session/report 此前没有前端入口）
import { Collapse, Modal, Table } from 'antd'
import { useTranslation } from 'react-i18next'
import FormulaRenderer from '../../../components/FormulaRenderer'
import { getSessionReport } from '../../../api/classLadder'

interface Props {
  report: Awaited<ReturnType<typeof getSessionReport>> | null
  onClose: () => void
}

export default function LadderReportModal({ report, onClose }: Props) {
  const { t } = useTranslation('classLadder')
  return (
    <Modal open={Boolean(report)} onCancel={onClose} footer={null} width={860}
      title={[t('reportTitle'), report && report.session ? report.session.class : null].filter(Boolean).join(' · ')}>
      {report && (
        <>
          <Table
            size="small" rowKey="id" pagination={false}
            dataSource={report.board}
            columns={[
              { title: '#', render: (_x, _r, i) => i + 1, width: 40 },
              { title: t('nameCol'), dataIndex: 'student_name', width: 110 },
              { title: t('reachedLevel'), dataIndex: 'reached_level', width: 90, render: (n: number) => t('boardReached', { n }) },
              { title: t('correctCount'), dataIndex: 'correct_count', width: 80 },
              { title: t('ladderScore'), dataIndex: 'ladder_score', width: 80 },
              {
                title: t('resultCol'), dataIndex: 'status', width: 90,
                render: (s: string) => (s === 'win' ? t('winTitle') : s === 'timeout' ? t('timeoutTitle') : t('loseTitle')),
              },
            ]}
            locale={{ emptyText: t('boardEmpty') }}
          />
          {report.runs.length > 0 && (
            <Collapse
              ghost style={{ marginTop: 12 }}
              items={report.runs.map((r) => ({
                key: String(r.run_id),
                label: (
                  <span>
                    <b>{r.student}</b>
                    {' · ' + t('boardReached', { n: r.reached_level })}
                    {' · ' + t('ladderScore') + ' ' + r.ladder_score}
                    {' · ' + t('pointsAwarded') + ' +' + r.points_awarded}
                  </span>
                ),
                children: (
                  <div className="cl-report-detail">
                    {r.detail.map((d) => (
                      <div key={d.level} className="cl-ovreview-row">
                        <b>{t('levelLabel', { n: d.level })}</b>
                        <span style={{ color: d.correct ? 'var(--cl-ok)' : undefined }}>
                          {d.correct ? t('correctTxt') : t('incorrectTxt')}
                        </span>
                        <span>{t('answerIs') + '：' + (d.correct_answer || '—')}</span>
                        {d.selected ? <span>{' · ' + t('yourPick') + '：' + d.selected}</span> : null}
                        {d.question ? <div className="exp"><FormulaRenderer content={d.question} /></div> : null}
                        {d.explanation ? <div className="exp">{'💡 '}<FormulaRenderer content={d.explanation} /></div> : null}
                      </div>
                    ))}
                  </div>
                ),
              }))}
            />
          )}
        </>
      )}
    </Modal>
  )
}
