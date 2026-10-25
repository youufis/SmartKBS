import React, { useMemo, useState } from 'react'
import { Card, Empty, Pagination, Spin } from 'antd'

/**
 * 通用「表格 → 卡片」窄屏渲染器。
 *
 * 直接复用页面已有的 antd Table columns（含 render 逻辑），把每一行摊成一张卡片：
 *   - 标题列（默认第一个可见列，可用 titleKey 指定）加粗、占满整行、不截断，
 *     比表格的 ellipsis 更好读
 *   - 其余列以「字段名: 值」纵向排列，值为空则整行省略
 *   - 操作列由原 render 返回的按钮组直接呈现
 *
 * 只在窄屏分支使用，桌面端仍走原 <Table>，因此不会改变桌面行为。
 *
 * 为什么窄屏要用卡片而不是「表格 + 左右滑」：窄屏下 antd 一旦有列宽/ellipsis 就切到
 * table-layout:fixed，列宽只认 <colgroup>，全局那条 min-width:max-content 兜不住，
 * 结果要么把长文本列撑成几千px（教师端作业中心实测 6794px），要么把没给宽度的列压成
 * 58px 直接省略号（积分流水的"说明"列）—— 两种都读不出内容。明细类表格一律走这里。
 */

export interface MobileCardColumn {
  title?: React.ReactNode
  dataIndex?: string | string[]
  key?: string
  render?: (value: any, record: any, index: number) => React.ReactNode
  hidden?: boolean
}

export interface MobileCardTableProps {
  dataSource: any[]
  columns: MobileCardColumn[]
  rowKey: string | ((record: any, index?: number) => string | number)
  loading?: boolean
  /** 传入则显示简洁分页；onChange 只回调页码（窄屏不提供改页大小） */
  pagination?: { current: number; pageSize: number; total: number; onChange: (page: number) => void } | false
  /** 指定卡片标题列（匹配 column 的 key 或 dataIndex）；缺省用第一个可见列 */
  titleKey?: string
  /** 前端分页：数据全在内存时由组件切片，窄屏不至于一次画上百张卡 */
  clientPageSize?: number
  emptyText?: React.ReactNode
}

const readValue = (record: any, dataIndex?: string | string[]) => {
  if (dataIndex === undefined) return undefined
  if (Array.isArray(dataIndex)) return dataIndex.reduce<any>((acc, k) => (acc == null ? acc : acc[k]), record)
  return (record as any)?.[dataIndex]
}

const isEmptyNode = (node: React.ReactNode) =>
  node === null || node === undefined || node === '' || (typeof node === 'string' && node.trim() === '') || node === '-'

const MobileCardTable: React.FC<MobileCardTableProps> = ({
  dataSource = [], columns = [], rowKey, loading,
  pagination, emptyText, titleKey, clientPageSize,
}) => {
  const visible = columns.filter((c) => !c.hidden)

  // 标题列可指定；找不到就退回第一个可见列，其余列保持原顺序跟在后面
  const [headCol, ...restCols] = useMemo(() => {
    if (!titleKey) return visible
    const i = visible.findIndex((c) => c.key === titleKey || c.dataIndex === titleKey)
    return i > 0 ? [visible[i], ...visible.slice(0, i), ...visible.slice(i + 1)] : visible
  }, [visible, titleKey])

  // 函数式 rowKey 必须把 index 传下去：页面里常见写法是 rowKey={(_, i) => String(i)}
  // （成绩/流水这类没有稳定 id 的表），漏传 index 会让每一行的 key 都是 "undefined"，
  // React 直接报 duplicate key（手机巡检实测抓到）。
  const keyOf = (record: any, index: number): string | number =>
    typeof rowKey === 'function' ? rowKey(record, index) : ((record as any)?.[rowKey] ?? index)

  // 组件内分页（与上面的服务端分页 pagination 各自独立，互不影响既有调用）
  const [page, setPage] = useState(1)
  const total = dataSource.length
  const size = clientPageSize && clientPageSize > 0 ? clientPageSize : 0
  const pageCount = size ? Math.max(1, Math.ceil(total / size)) : 1
  const current = Math.min(page, pageCount)
  const rows = size ? dataSource.slice((current - 1) * size, current * size) : dataSource

  if (!loading && dataSource.length === 0) {
    return <>{emptyText ?? <Empty />}</>
  }

  return (
    <Spin spinning={!!loading}>
      <div>
        {rows.map((record, index) => (
          <Card
            key={keyOf(record, index)}
            size="small"
            style={{ marginBottom: 8 }}
            styles={{ body: { padding: '10px 12px' } }}
          >
            {headCol && (
              <div style={{ fontSize: 14, fontWeight: 600, wordBreak: 'break-word' }}>
                {headCol.render
                  ? headCol.render(readValue(record, headCol.dataIndex), record, (current - 1) * size + index)
                  : readValue(record, headCol.dataIndex)}
              </div>
            )}
            {restCols.map((col, i) => {
              const node = col.render
                ? col.render(readValue(record, col.dataIndex), record, (current - 1) * size + index)
                : readValue(record, col.dataIndex)
              if (isEmptyNode(node)) return null
              return (
                <div
                  key={col.key ?? String(i)}
                  className="mct-row"
                  style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}
                >
                  <span style={{ flex: '0 0 auto', fontSize: 12, color: 'var(--text-tertiary)', minWidth: 56 }}>{col.title}</span>
                  <span style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' }}>{node}</span>
                </div>
              )
            })}
          </Card>
        ))}
        {size > 0 && total > size && (
          <Pagination
            current={current}
            pageSize={size}
            total={total}
            simple
            size="small"
            onChange={setPage}
            style={{ textAlign: 'center', paddingTop: 8 }}
          />
        )}
        {pagination && pagination.total > pagination.pageSize && (
          <Pagination
            current={pagination.current}
            pageSize={pagination.pageSize}
            total={pagination.total}
            simple
            size="small"
            onChange={pagination.onChange}
            style={{ textAlign: 'center', paddingTop: 4 }}
          />
        )}
      </div>
    </Spin>
  )
}

export default MobileCardTable
