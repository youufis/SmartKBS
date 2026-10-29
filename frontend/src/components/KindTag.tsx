/**
 * KindTag — 网页资源的「内容类型」标签，点一下直接改类型。
 *
 * 四个页面共用一处实现（我的资源 / 共享页卡片 / 绑定候选 / 资源管理），
 * 免得同一个交互写四遍、改一处漏三处。
 *
 * 视觉口径：
 *  - 金色带「·」= 人工标注（优先级最高，压过文件名推断，且跟着改名走），可撤销；
 *  - 灰色 = 系统按文件名推断出来的，标一次就不再会因为改名而掉类。
 * 不传 onChanged（或不传 path）时退化成只读标签，只显示不能改。
 */
import React from 'react'
import { Dropdown, Tag, Tooltip, message } from 'antd'
import { useTranslation } from 'react-i18next'
import * as resourcesApi from '../api/resources'
import { KIND_LABELS } from '../constants/resourceKinds'
import { subKindLabel } from '../utils/resourceType'

const CLEAR = '__clear__'

const KindTag: React.FC<{
  /** 标注键：相对项目根的资源路径；相对 html 目录的写法后端也会统一 */
  path?: string
  kind?: string
  /** manual=人工标的；ai/rule=系统标的；空=没有标注 */
  setBy?: string
  fontSize?: number
  onChanged?: () => void | Promise<void>
}> = ({ path, kind, setBy, fontSize = 11, onChanged }) => {
  const { t } = useTranslation(['menu', 'curriculum'])
  if (!kind) return null
  const manual = setBy === 'manual'
  const editable = !!path && !!onChanged
  const tr = t as unknown as (k: string) => string
  // 两类练习的名字只差一个字，差别却在「会不会留成绩」—— 只有 Tooltip 说得清
  const hintKey = `subKind.${kind}Hint`
  const hintRaw = tr(hintKey)
  const hint = hintRaw === hintKey ? '' : hintRaw
  const tag = (
    <Tag
      color={manual ? 'gold' : undefined}
      style={{ fontSize, marginInlineEnd: 0, cursor: editable ? 'pointer' : 'default' }}
    >
      {subKindLabel(t, kind)}{manual ? ' ·' : ''}{editable ? ' ▾' : ''}
    </Tag>
  )
  const tagged = hint ? <Tooltip title={hint}>{tag}</Tooltip> : tag
  if (!editable) return tagged
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        selectedKeys: [kind],
        items: [
          ...Object.keys(KIND_LABELS).map((k) => ({ key: k, label: subKindLabel(t, k) })),
          ...(manual ? [{ key: CLEAR, label: t('kindClearMark'), danger: true }] : []),
        ],
        onClick: async ({ key, domEvent }) => {
          domEvent?.stopPropagation?.()
          const clear = key === CLEAR
          try {
            await resourcesApi.setKindMark(String(path), clear ? '' : String(key))
            message.success(clear
              ? t('kindCleared')
              : t('kindSetOk', { name: subKindLabel(t, String(key)) }))
            await onChanged?.()
          } catch (e: unknown) {
            const err = e as { response?: { data?: { detail?: string } }; message?: string }
            message.error(err?.response?.data?.detail || err?.message || t('operationFailed'))
          }
        },
      }}
    >
      <span onClick={(e) => e.stopPropagation()}>{tagged}</span>
    </Dropdown>
  )
}

export default KindTag