import React, { useState } from 'react'
import { Space, Tag } from 'antd'
import { useTranslation } from 'react-i18next'
import apiClient from '../api/client'
import { runAiTaskJob } from '../api/aiTask'
import { describeProgress } from '../utils/aiProgress'
import { message } from '../utils/feedback'
import PlaceholderManager from './PlaceholderManager'
import FormulaRenderer from './FormulaRenderer'
import type { QuestionInfo } from '../types'

interface Props {
  /** 当前题目（含 svg_content / media_placeholders / media_files） */
  question: QuestionInfo
  /** 任一配图动作完成后回传最新详情，供外层同步角标与列表 */
  onChanged: (q: QuestionInfo) => void
  /** 成功动作后是否顺手刷新外层列表（默认 true） */
  reloadList?: () => void
}

/**
 * 配图管理面板（从原「编辑弹窗 → 再开一个配图弹窗」的嵌套结构里抽出来）。
 *
 * 抽成独立组件的原因：
 *   1. 嵌套 Modal 在暗色主题和窄屏下都很别扭，而且关闭上层后状态不刷新；
 *   2. 它自带一套「提交异步任务 + 轮询进度 + 回读详情」的逻辑，体积比表单还大，
 *      留在页面里会让页面继续失控；
 *   3. 上层只需要传一个 question 和 onChanged，状态同步路径只有一条。
 */
const QuestionMediaPanel: React.FC<Props> = ({ question, onChanged, reloadList }) => {
  const { t } = useTranslation('questions')
  const [svgLoading, setSvgLoading] = useState(false)
  const [wanxiangLoading, setWanxiangLoading] = useState(false)
  const [progress, setProgress] = useState('')

  const refresh = async () => {
    const { data } = await apiClient.get(`/api/questions/${question.id}`)
    onChanged(data)
    reloadList?.()
  }

  /**
   * 配图类动作统一走后台任务 + 轮询进度。同步等待叠加「最多 3 个模型 × 3 次重试」
   * 能到几分钟，反代必断；断连后老师看到「失败」，图其实已经生成并计费。
   */
  const runTask = async (
    url: string,
    okKey: string,
    failKey: string,
    setLoading?: (v: boolean) => void,
  ) => {
    setLoading?.(true)
    setProgress(t('pmProgWorking'))
    try {
      await runAiTaskJob(url, null, (p) => setProgress(describeProgress(p, t)))
      message.success(t(okKey))
      await refresh()
    } catch (e: any) {
      if (e?.aiTaskTimeout) {
        // 超时 ≠ 失败：后台还在生成，提示失败会诱导重复点击、重复烧配额
        message.warning(t('generateStillRunning'))
        await refresh()
      } else {
        message.error(e?.response?.data?.detail || e?.message || t(failKey))
      }
    } finally {
      setProgress('')
      setLoading?.(false)
    }
  }

  const handleRegenerateSVG = () =>
    runTask(`/api/questions/${question.id}/generate-svg-async`, 'svgRegenerated', 'svgGenFail', setSvgLoading)

  const handleGenerateImage = () =>
    runTask(`/api/questions/${question.id}/generate-image-async`, 'imageGenerated', 'imageGenFail', setWanxiangLoading)

  const handleGenerateMedia = (key: string) =>
    runTask(`/api/questions/${question.id}/generate-media/${key}/async`, 'imageGenerated', 'imageGenFail')

  const handleDeleteSVG = async () => {
    try {
      await apiClient.delete(`/api/questions/${question.id}/svg`)
      message.success(t('svgDeleted'))
      await refresh()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('deleteFail'))
    }
  }

  const handleUploadMedia = async (key: string, file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    try {
      await apiClient.post(`/api/questions/${question.id}/upload-media/${key}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      message.success(t('imageUploaded'))
      await refresh()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('uploadFail'))
    }
  }

  const handleDeleteMedia = async (key: string) => {
    try {
      await apiClient.delete(`/api/questions/${question.id}/media/${key}`)
      message.success(t('imageDeleted'))
      await refresh()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('deleteFail'))
    }
  }

  const imgCount = Array.isArray(question.media_files) ? question.media_files.length : 0

  return (
    <div>
      {/* 先给出题目上下文：原来只显示 #id，老师得靠记忆确认在给哪道题配图 */}
      <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        <Tag style={{ marginInlineEnd: 8 }}>#{question.id}</Tag>
        <span style={{ display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom' }}>
          <FormulaRenderer
            content={question.question_text.length > 90 ? `${question.question_text.slice(0, 90)}…` : question.question_text}
            inline
          />
        </span>
      </div>
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Tag color={question.has_svg ? 'blue' : 'default'}>{question.has_svg ? t('hasSvg') : t('noSvg')}</Tag>
        <Tag color={imgCount > 0 ? 'green' : 'default'}>{t('imageCount', { count: imgCount })}</Tag>
        {(question.media_placeholders?.length || 0) > 0 && (
          <Tag color="orange">{t('placeholderCount', { count: question.media_placeholders?.length || 0 })}</Tag>
        )}
      </Space>
      <PlaceholderManager
        questionId={question.id}
        svgContent={question.svg_content}
        hasSvg={question.has_svg}
        placeholders={question.media_placeholders}
        mediaFiles={question.media_files}
        svgLoading={svgLoading}
        wanxiangLoading={wanxiangLoading}
        onRegenerateSVG={handleRegenerateSVG}
        onDeleteSVG={handleDeleteSVG}
        onGenerateImage={handleGenerateImage}
        onGenerateMedia={handleGenerateMedia}
        onUploadMedia={handleUploadMedia}
        onDeleteMedia={handleDeleteMedia}
        progressText={progress}
      />
    </div>
  )
}

export default QuestionMediaPanel
