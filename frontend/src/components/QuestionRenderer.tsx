/**
 * QuestionRenderer — 统一试题渲染组件
 *
 * 按优先级渲染：
 * 1. 公式（question_text 中的 $...$ / $$...$$）
 * 2. SVG 配图（has_svg=1）
 * 3. 已生成的图片（media_files）
 * 4. 失败的占位符（显示重试按钮）
 */
import React from 'react'
import { Tag, Space, Button } from 'antd'
import FormulaRenderer from './FormulaRenderer'
import MediaDisplay from './MediaDisplay'
import type { QuestionInfo } from '../types'

interface QuestionRendererProps {
  /** 试题数据（只需包含渲染所需字段） */
  question: Pick<QuestionInfo, 'question_text' | 'svg_content' | 'has_svg' | 'options' | 'correct_answer' | 'explanation'> & {
    media_files?: any
    media_placeholders?: any[]
  }
  /** 是否显示答案和解析 */
  showAnswer?: boolean
  /** 是否显示配图 */
  showMedia?: boolean
  /** 学生答案（用于结果页展示） */
  studentAnswer?: string
  /** 是否显示操作按钮（教师端） */
  showActions?: boolean
  /** 上传/生图占位符回调 */
  onManageMedia?: () => void
}

const QuestionRenderer: React.FC<QuestionRendererProps> = ({
  question,
  showAnswer = false,
  showMedia = true,
  studentAnswer,
  showActions = false,
  onManageMedia,
}) => {
  return (
    <div>
      {/* 题目文本（含公式） */}
      <div style={{ fontSize: 15, lineHeight: 1.8, marginBottom: 12 }}>
        <FormulaRenderer content={question.question_text} />
      </div>

      {/* SVG + 万相配图 */}
      {showMedia && (
        <MediaDisplay
          svgContent={question.svg_content}
          hasSvg={question.has_svg}
          mediaFiles={(question as any).media_files}
        />
      )}

      {/* 学生答案（在结果页显示） */}
      {studentAnswer !== undefined && (
        <div style={{ marginTop: 8, padding: '4px 8px', background: '#f6f8fa', borderRadius: 4 }}>
          <Tag color="blue">你的答案</Tag>
          <FormulaRenderer content={studentAnswer || '（未作答）'} inline />
        </div>
      )}

      {/* 正确答案和解析 */}
      {showAnswer && question.correct_answer && (
        <div style={{ marginTop: 8 }}>
          <Space>
            <Tag color="green">正确答案</Tag>
            <FormulaRenderer content={question.correct_answer} inline />
          </Space>
        </div>
      )}
      {showAnswer && question.explanation && (
        <div style={{
          marginTop: 8,
          padding: '8px 12px',
          background: '#f0f5ff',
          borderRadius: 6,
          borderLeft: '3px solid #1677ff',
        }}>
          <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>📖 解析</div>
          <FormulaRenderer content={question.explanation} />
        </div>
      )}

      {/* 占位符管理入口（教师端） */}
      {showActions && onManageMedia && (
        <div style={{ marginTop: 8 }}>
          <Button size="small" onClick={onManageMedia}>
            🎨 配图管理
          </Button>
        </div>
      )}
    </div>
  )
}

export default QuestionRenderer
