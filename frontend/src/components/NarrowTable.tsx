import React from 'react'
import { Table } from 'antd'
import MobileCardTable from './MobileCardTable'
import { useIsMobile } from '../hooks/useIsMobile'

/**
 * 窄屏表格策略组件：桌面端原样渲染 antd Table，手机端把同一套 columns 摊成卡片。
 *
 * 为什么要统一收口在这里（而不是每个页面各写一份 isMobile 三元）：
 * 1. 窄屏下 antd 只要有列宽或 ellipsis 就切到 table-layout:fixed，列宽只认 <colgroup>，
 *    mobile.css 那条 min-width:max-content 兜不住 —— 实测两种坏法：教师端作业中心的
 *    「作业要求」长文把表撑到 6794px 宽，积分流水的「说明」列被压成 58px 省略号，
 *    两种都读不出内容。
 * 2. 明细类表格（流水、名单、规则表）行多列碎，卡片比「左右滑的表格」好读，
 *    也不会出现「其实还能横滑」但没人知道的情况。
 * 3. 调用点只换个标签 + 三个 card* 参数，列定义仍是一份，不会出现桌面改了手机忘改。
 *
 * 桌面端零影响：非窄屏时本组件就是 <Table> 的透传。
 * 这里不直接 extends TableProps：antd v6 的 TablePaginationConfig 在 .d.ts 里继承了
 * 一个解析不到的 PaginationProps，一旦经过接口继承，pagination={{ pageSize }} 就会被
 * 判成「多余属性」。所以本组件对 pagination 只做透传，不重新约束它的形状。
 */
export interface NarrowTableProps {
  /** 桌面端列定义（卡片模式复用同一份 render） */
  columns: any[]
  dataSource?: any[]
  rowKey?: string | ((record: any, index?: number) => string | number)
  className?: string
  size?: 'small' | 'middle' | 'large'
  loading?: boolean
  /** 原样透传给桌面端 antd Table；窄屏走卡片时由 cardPageSize 接管 */
  pagination?: unknown
  /** 卡片标题列（匹配 column 的 key 或 dataIndex）；缺省用第一个可见列 */
  cardTitleKey?: string
  /** 卡片模式下的前端分页条数；不传则整表一次画完 */
  cardPageSize?: number
  /** 卡片模式隐藏的列（重操作、次要字段留电脑端），按 column 的 key/dataIndex 匹配 */
  cardHiddenKeys?: string[]
  /** 其余 antd Table 属性（scroll / locale / bordered / onChange 等）原样透传 */
  [key: string]: unknown
}

const NarrowTable: React.FC<NarrowTableProps> = ({
  cardTitleKey, cardPageSize, cardHiddenKeys, columns, dataSource, rowKey, ...rest
}) => {
  const isMobile = useIsMobile()

  if (isMobile) {
    let cardCols = columns.filter((c: any) => !c?.hidden)
    if (cardHiddenKeys?.length) {
      cardCols = cardCols.filter((c: any) => !cardHiddenKeys.includes(String(c.key ?? c.dataIndex)))
    }
    return (
      <MobileCardTable
        dataSource={(dataSource ?? []) as any[]}
        columns={cardCols}
        rowKey={rowKey ?? 'id'}
        loading={!!rest.loading}
        titleKey={cardTitleKey}
        clientPageSize={cardPageSize}
      />
    )
  }

  return (
    <Table
      columns={columns}
      dataSource={dataSource}
      rowKey={rowKey as any}
      {...(rest as any)}
    />
  )
}

export default NarrowTable
