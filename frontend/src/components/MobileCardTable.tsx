import React from 'react'
import { Card, Empty, Pagination, Spin } from 'antd'

/**
 * 通用「表格 → 卡片」窄屏渲染器。
 *
 * 直接复用页面已有的 antd Table columns（含 render 逻辑），把每一行摊成一张卡片：
 *   - 第一个可见列作为卡片标题（加粗、占满整行、不截断，比表格的 ellipsis 更好读）
 *   - 其余列以「字段名: 值」纵向排列，值为空则整行省略
 *   - 操作列由原 render 返回的按钮组直接呈现
 *
 * 只在窄屏分支使用，桌面端仍走原 <Table>，因此不会改变桌面行为。
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
  rowKey: string | ((record: any) => string | number)
  loading?: boolean
  /** 传入则显示简洁分页；onChange 只回调页码（窄屏不提供改页大小） */
  pagination?: { current: number; pageSize: number; total: number; onChange: (page: number) => void } | false
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
  dataSource = [], columns = [], rowKey, loading, pagination, emptyText,
}) => {
  const visible = columns.filter((c) => !c.hidden)
  const keyOf = (record: any, index: number): string | number =>
    typeof rowKey === 'function' ? rowKey(record) : ((record as any)?.[rowKey] ?? index)

  if (!loading && dataSource.length === 0) {
    return <>{emptyText ?? <Empty />}</>
  }

  return (
    <Spin spinning={!!loading}>
      <div>
        {dataSource.map((record, index) => {
          const [headCol, ...restCols] = visible
          return (
            <Card
              key={keyOf(record, index)}
              size="small"
              style={{ marginBottom: 8 }}
              styles={{ body: { padding: '10px 12px' } }}
            >
              {headCol && (
                <div style={{ fontSize: 14, fontWeight: 600, wordBreak: 'break-word' }}>
                  {headCol.render ? headCol.render(readValue(record, headCol.dataIndex), record, index) : readValue(record, headCol.dataIndex)}
                </div>
              )}
              {restCols.map((col, i) => {
                const node = col.render ? col.render(readValue(record, col.dataIndex), record, index) : readValue(record, col.dataIndex)
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
          )
        })}
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
