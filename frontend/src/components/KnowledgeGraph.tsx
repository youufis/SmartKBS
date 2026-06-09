/**
 * 知识图谱可视化组件
 * 使用 @antv/g6 v5 渲染课程知识图谱，支持：
 * - 树形布局 / 力导向布局
 * - 节点点击 / 悬停交互
 * - 知识点前置依赖可视化
 * - 学生进度热力图
 * - 搜索高亮
 * - 导出图片
 */
import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import { Spin, Empty, Button, Space, Tooltip, Select, message, Input, Radio, Badge } from 'antd'
import {
  ZoomInOutlined, ZoomOutOutlined, UndoOutlined,
  PictureOutlined, ApartmentOutlined, BranchesOutlined,
  SearchOutlined, RobotOutlined, NodeIndexOutlined,
} from '@ant-design/icons'
import { Graph } from '@antv/g6'
import type { Course, GraphNode, GraphEdge, KnowledgeGraphData, KnowledgePoint } from '../types'
import * as curriculumApi from '../api/curriculum'

interface KnowledgeGraphProps {
  course: Course
  isStudent: boolean
  isTeacherOrAdmin: boolean
  onKpSelect?: (kp: KnowledgePoint) => void
  /** 图谱高度，默认 600px */
  height?: number
}

/** 难度对应的颜色 */
const DIFFICULTY_COLORS: Record<string, string> = {
  easy: '#52c41a',
  medium: '#faad14',
  hard: '#ff4d4f',
}

/** 进度对应的填充色 */
const PROGRESS_FILLS: Record<string, string> = {
  completed: '#e6f7e6',
  in_progress: '#e6f4ff',
  not_started: '#fafafa',
}

/** 进度对应的描边色 */
const PROGRESS_STROKES: Record<string, string> = {
  completed: '#52c41a',
  in_progress: '#1677ff',
  not_started: '#d9d9d9',
}

/** 边样式 */
const EDGE_STYLES: Record<string, { stroke: string; lineWidth: number; lineDash?: number[] }> = {
  belongs_to: { stroke: '#d9d9d9', lineWidth: 1 },
  prerequisite: { stroke: '#faad14', lineWidth: 2, lineDash: [5, 5] },
  related: { stroke: '#b37feb', lineWidth: 1.5, lineDash: [3, 3] },
}

const EDGE_LABELS: Record<string, string> = {
  belongs_to: '包含',
  prerequisite: '前置依赖',
  related: '关联',
}

const KnowledgeGraph: React.FC<KnowledgeGraphProps> = ({
  course,
  isStudent,
  isTeacherOrAdmin,
  onKpSelect,
  height = 600,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const [loading, setLoading] = useState(false)
  const [graphData, setGraphData] = useState<KnowledgeGraphData | null>(null)
  const [layoutType, setLayoutType] = useState<'tree' | 'force'>('tree')
  const [searchText, setSearchText] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [inferring, setInferring] = useState(false)

  // ── 加载数据 ──
  const loadGraphData = useCallback(async () => {
    if (!course?.id) return
    setLoading(true)
    try {
      const data = await curriculumApi.getKnowledgeGraph(course.id)
      setGraphData(data)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '加载知识图谱失败')
    } finally {
      setLoading(false)
    }
  }, [course?.id])

  useEffect(() => {
    loadGraphData()
  }, [loadGraphData])

  // ── G6 节点的完整样式配置 ──
  const nodeConfig = useMemo(() => ({
    key: (d: any) => d.id,
    data: (d: any) => d.data || d,
    style: (d: any) => {
      const node = d.data || d
      const isSelected = selectedNodeId === node.id
      const isSearchMatch = searchText && node.label?.toLowerCase().includes(searchText.toLowerCase())

      if (node.type === 'chapter' || node.type === 'section') {
        return {
          labelText: node.label,
          labelFill: '#333',
          labelFontWeight: node.type === 'chapter' ? 600 : 400,
          labelFontSize: node.type === 'chapter' ? 14 : 12,
          labelPlacement: 'bottom',
          labelOffsetY: 6,
          fill: node.type === 'chapter' ? '#e6f4ff' : '#f6ffed',
          stroke: node.type === 'chapter' ? '#1677ff' : '#52c41a',
          lineWidth: isSelected ? 3 : 1.5,
          size: node.type === 'chapter' ? 24 : 20,
          shape: 'circle',
          opacity: isSearchMatch !== false ? 1 : 0.3,
          cursor: 'pointer',
        }
      }

      // 知识点节点
      const progStatus = node.progress_status || 'not_started'
      const diffColor = DIFFICULTY_COLORS[node.difficulty] || '#999'
      return {
        labelText: node.label,
        labelFill: '#333',
        labelFontSize: 11,
        labelPlacement: 'bottom',
        labelOffsetY: 4,
        fill: isStudent ? (PROGRESS_FILLS[progStatus] || '#fafafa') : '#fff',
        stroke: isStudent ? (PROGRESS_STROKES[progStatus] || '#d9d9d9') : diffColor,
        lineWidth: isStudent && progStatus === 'completed' ? 3 : (isSelected ? 3 : (isStudent ? 2 : 1.5)),
        size: 16,
        shape: 'circle',
        opacity: isSearchMatch !== false ? 1 : 0.3,
        cursor: 'pointer',
      }
    },
    state: {
      selected: {
        lineWidth: 3,
        shadowColor: '#1677ff',
        shadowBlur: 10,
      },
      highlight: {
        opacity: 1,
      },
    },
  }), [selectedNodeId, searchText, isStudent])

  // ── 边配置 ──
  const edgeConfig = useMemo(() => ({
    style: (d: any) => {
      const edge = d.data || d
      const style = EDGE_STYLES[edge.type] || EDGE_STYLES.belongs_to
      return {
        stroke: style.stroke,
        lineWidth: style.lineWidth,
        lineDash: style.lineDash,
        endArrow: edge.type !== 'belongs_to',
        labelText: edge.type !== 'belongs_to' ? (EDGE_LABELS[edge.type] || '') : '',
        labelFontSize: 9,
        labelFill: style.stroke,
        labelBackground: true,
        labelBackgroundFill: '#fff',
        labelBackgroundOpacity: 0.8,
      }
    },
  }), [])

  // ── 布局 ──
  const layoutConfig = useMemo(() => {
    if (layoutType === 'force') {
      return {
        type: 'force',
        preventOverlap: true,
        nodeStrength: -200,
        edgeStrength: 0.5,
        linkDistance: 150,
        animation: true,
      }
    }
    return {
      type: 'dendrogram',
      direction: 'LR',
      nodeSep: 30,
      rankSep: 200,
      animation: true,
    }
  }, [layoutType])

  // ── 初始化/更新 G6 图谱 ──
  useEffect(() => {
    if (!containerRef.current || !graphData?.nodes?.length) return

    // 清理旧实例
    if (graphRef.current) {
      graphRef.current.destroy()
      graphRef.current = null
    }

    // G6 v5 数据格式转换（使用类型断言适配 G6 类型）
    const g6Data = {
      nodes: graphData.nodes.map((n: GraphNode) => ({
        id: n.id,
        data: { ...n } as Record<string, unknown>,
      })),
      edges: graphData.edges.map((e: GraphEdge) => ({
        source: e.source,
        target: e.target,
        data: { ...e } as Record<string, unknown>,
      })),
    }

    const graph = new Graph({
      container: containerRef.current,
      data: g6Data as any,
      layout: layoutConfig as any,
      node: nodeConfig as any,
      edge: edgeConfig as any,
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
      autoFit: 'view' as any,
      animation: true,
    })

    // ── 节点点击事件 ──
    graph.on('node:click', (evt: any) => {
      const nodeId = evt.target?.id || evt.item?.id
      if (nodeId) {
        setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId))
        const node = graphData.nodes.find((n: GraphNode) => n.id === nodeId)
        if (node?.type === 'kp' && onKpSelect) {
          // 构造 KnowledgePoint 对象传给父组件
          onKpSelect({
            id: parseInt(nodeId.replace('kp_', ''), 10),
            chapter_id: 0,
            name: node.label || '',
            description: node.description || '',
            learning_objectives: node.learning_objectives || '',
            difficulty: node.difficulty || 'medium',
            estimated_minutes: node.estimated_minutes || 0,
            sort_order: 0,
            status: 'active',
            progress_status: node.progress_status as any,
          })
        }
      }
    })

    // ── 节点悬停 ──
    graph.on('node:pointerenter', (evt: any) => {
      const nodeId = evt.target?.id || evt.item?.id
      if (nodeId) {
        const node = graphData.nodes.find((n: GraphNode) => n.id === nodeId)
        if (node) {
          const tooltip = document.getElementById('graph-tooltip')
          if (tooltip) {
            tooltip.innerHTML = `
              <div style="font-weight:600;margin-bottom:4px">${node.label}</div>
              ${node.description ? `<div style="color:#666;font-size:12px">${node.description}</div>` : ''}
              ${node.difficulty ? `<div style="margin-top:4px"><span style="color:${DIFFICULTY_COLORS[node.difficulty] || '#999'}">●</span> ${node.difficulty === 'easy' ? '简单' : node.difficulty === 'medium' ? '中等' : '困难'}</div>` : ''}
              ${node.estimated_minutes ? `<div style="color:#999;font-size:12px">⏱ ${node.estimated_minutes}分钟</div>` : ''}
              ${node.resource_count ? `<div style="color:#1677ff;font-size:12px">📎 ${node.resource_count}个资源</div>` : ''}
              ${isStudent && node.progress_status ? `<div style="margin-top:4px">状态: ${node.progress_status === 'completed' ? '✅ 已完成' : node.progress_status === 'in_progress' ? '⏳ 学习中' : '⬜ 未开始'}</div>` : ''}
            `
            tooltip.style.display = 'block'
          }
        }
      }
    })
    graph.on('node:pointerleave', () => {
      const tooltip = document.getElementById('graph-tooltip')
      if (tooltip) tooltip.style.display = 'none'
    })

    graph.render()
    graphRef.current = graph

    return () => {
      graph.destroy()
      graphRef.current = null
    }
  }, [graphData, layoutConfig, nodeConfig, edgeConfig, onKpSelect, isStudent])

  // ── 缩放控制 ──
  const handleZoomIn = () => graphRef.current?.zoomTo(graphRef.current.getZoom() * 1.2)
  const handleZoomOut = () => graphRef.current?.zoomTo(graphRef.current.getZoom() / 1.2)
  const handleFitView = () => graphRef.current?.fitView()

  // ── 导出图片 ──
  const handleExport = async () => {
    if (!graphRef.current) return
    try {
      const dataUrl = await graphRef.current.toDataURL()
      const link = document.createElement('a')
      link.download = `${course.name || '知识图谱'}.png`
      link.href = dataUrl
      link.click()
    } catch (err) {
      message.error('导出失败')
    }
  }

  // ── AI 推断前置关系 ──
  const handleAiInfer = async () => {
    if (!course?.id) return
    setInferring(true)
    try {
      const result = await curriculumApi.aiInferPrerequisites(course.id)
      message.success(result.message)
      await loadGraphData()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'AI 推断失败')
    } finally {
      setInferring(false)
    }
  }

  // ── 搜索过滤 ──
  const handleSearch = (value: string) => {
    setSearchText(value)
    if (value && graphRef.current) {
      const nodes = graphData?.nodes || []
      const match = nodes.find((n: GraphNode) =>
        n.label?.toLowerCase().includes(value.toLowerCase()),
      )
      if (match) {
        graphRef.current.focusElement(match.id)
      }
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* ── 工具栏 ── */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
        flexWrap: 'wrap',
        gap: 8,
      }}>
        <Space>
          <Radio.Group
            value={layoutType}
            onChange={(e) => setLayoutType(e.target.value)}
            size="small"
            buttonStyle="solid"
          >
            <Radio.Button value="tree">
              <BranchesOutlined /> 树形
            </Radio.Button>
            <Radio.Button value="force">
              <ApartmentOutlined /> 力导
            </Radio.Button>
          </Radio.Group>

          <Input.Search
            placeholder="搜索知识点..."
            allowClear
            size="small"
            style={{ width: 200 }}
            prefix={<SearchOutlined />}
            onSearch={handleSearch}
            onChange={(e) => !e.target.value && handleSearch('')}
          />
        </Space>

        <Space>
          <Tooltip title="放大">
            <Button size="small" icon={<ZoomInOutlined />} onClick={handleZoomIn} />
          </Tooltip>
          <Tooltip title="缩小">
            <Button size="small" icon={<ZoomOutOutlined />} onClick={handleZoomOut} />
          </Tooltip>
          <Tooltip title="适应画布">
            <Button size="small" icon={<UndoOutlined />} onClick={handleFitView} />
          </Tooltip>
          <Tooltip title="导出为 PNG">
            <Button size="small" icon={<PictureOutlined />} onClick={handleExport} />
          </Tooltip>
          {isTeacherOrAdmin && (
            <Tooltip title="AI 推断前置关系">
              <Button
                size="small"
                icon={<RobotOutlined />}
                loading={inferring}
                onClick={handleAiInfer}
              >
                AI 推断
              </Button>
            </Tooltip>
          )}
          <Badge count={graphData?.total_nodes || 0} style={{ backgroundColor: '#1677ff' }} overflowCount={999}>
            <span style={{ padding: '0 8px' }}><NodeIndexOutlined /> 节点</span>
          </Badge>
        </Space>
      </div>

      {/* ── 图例 ── */}
      <div style={{
        display: 'flex', gap: 16, marginBottom: 8,
        fontSize: 12, color: '#666', flexWrap: 'wrap',
      }}>
        <span>● 章</span>
        <span style={{ color: '#52c41a' }}>● 节</span>
        <span style={{ color: '#52c41a' }}>● 简单</span>
        <span style={{ color: '#faad14' }}>● 中等</span>
        <span style={{ color: '#ff4d4f' }}>● 困难</span>
        <span>--- 前置依赖</span>
        <span>··· 关联</span>
        {isStudent && (
          <>
            <span style={{ color: '#52c41a' }}>◉ 已完成</span>
            <span style={{ color: '#1677ff' }}>◉ 学习中</span>
          </>
        )}
      </div>

      {/* ── 图谱容器 ── */}
      <div ref={containerRef} style={{ width: '100%', height, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa' }}>
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height }}>
            <Spin tip="加载知识图谱..." />
          </div>
        )}
        {!loading && (!graphData?.nodes?.length) && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height }}>
            <Empty description="暂无课程数据">
              {isTeacherOrAdmin && (
                <Button type="primary" onClick={handleAiInfer} loading={inferring}>
                  AI 推断前置关系
                </Button>
              )}
            </Empty>
          </div>
        )}
      </div>

      {/* ── 悬浮 Tooltip ── */}
      <div
        id="graph-tooltip"
        style={{
          display: 'none',
          position: 'absolute',
          background: '#fff',
          border: '1px solid #e8e8e8',
          borderRadius: 6,
          padding: '8px 12px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          pointerEvents: 'none',
          zIndex: 1000,
          fontSize: 13,
          maxWidth: 260,
        }}
      />
    </div>
  )
}

export default KnowledgeGraph
