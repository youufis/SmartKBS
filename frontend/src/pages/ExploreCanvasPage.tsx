/** 探索画布 · 列表页：卡片墙（悬停菜单 / 真实缩略图 / 搜索直达命中页）+ 新建 + 回收站 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Card, Dropdown, Empty, Input, Modal, Pagination, Select, Space, Spin, Tabs, Tag, Tooltip, message } from 'antd'
import { DeleteOutlined, MoreOutlined, PlusOutlined, PlusSquareOutlined, RestOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import PageHeader from '../components/PageHeader'
import { useAuthStore } from '../stores/authStore'
import { authedFileUrl } from '../api/client'
import {
  archiveCanvas, createCanvas, deleteTemplate, listArchives, listCanvases, listShares, listTemplates, listTrash, renameCanvas, restoreCanvas, revokeShare, applyTemplate,
  type ExploreCanvasMeta, type ShareMeta, type TemplateMeta,
} from '../api/explore'

/** 预置画布封面表情：品牌统一、归属感放画布名（命名定稿 2026-11-08） */
const PRESET_EMOJI: Record<string, string> = {
  question_pile: '❓',
  doodle: '🎨',
  explore_notes: '🧭',
  lesson_inspo: '📚',
  asset_workshop: '🧰',
  self_training: '✨',
  blank: '🖼️',
  from_template: '📐',
}

const PRESET_GRADIENT: Record<string, string> = {
  question_pile: 'linear-gradient(135deg, #eef4ff, #d9e8ff)',
  doodle: 'linear-gradient(135deg, #fff3e6, #ffe2c4)',
  explore_notes: 'linear-gradient(135deg, #e8f8f0, #d0f0df)',
  lesson_inspo: 'linear-gradient(135deg, #f3ecff, #e3d4ff)',
  asset_workshop: 'linear-gradient(135deg, #fff0f3, #ffd8e1)',
  self_training: 'linear-gradient(135deg, #e6f7ff, #cbeaff)',
  from_template: 'linear-gradient(135deg, #e9fbf4, #c8f2e2)',
  blank: 'linear-gradient(135deg, #f5f7fa, #e7ecf3)',
}

const ExploreCanvasPage: React.FC = () => {
  const nav = useNavigate()
  const { t } = useTranslation('explore')
  const IS_STUDENT = useAuthStore((s) => s.user?.role) === 'student'
  const [list, setList] = useState<ExploreCanvasMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [presetKey, setPresetKey] = useState('blank')
  const [trashOpen, setTrashOpen] = useState(false)
  const [trash, setTrash] = useState<ExploreCanvasMeta[]>([])
  const [renameId, setRenameId] = useState(0)
  const [renameVal, setRenameVal] = useState('')
  // ── M2：模板库 / 分享列表 ──
  const [tab, setTab] = useState('wall')
  const [tpls, setTpls] = useState<TemplateMeta[]>([])
  const [shares, setShares] = useState<ShareMeta[]>([])
  const [tplLoading, setTplLoading] = useState(false)
  const [shareQuery, setShareQuery] = useState('')
  const [sharePage, setSharePage] = useState(1)
  const [sharesLoading, setSharesLoading] = useState(false)

  const refresh = useCallback(async (q = '') => {
    try {
      setList(await listCanvases(q))
      const arch = await listArchives().catch(() => [])
      const map: Record<number, string> = {}
      for (const a of arch) {
        if (a.image_src && !map[a.canvas_id]) map[a.canvas_id] = a.image_src
      }
      setThumbs(map)
    } catch {
      message.error('画布列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const ms = window.setTimeout(() => { void refresh(query.trim()) }, 350)
  return () => window.clearTimeout(ms)
  }, [query, refresh])

  const openCanvas = (c: ExploreCanvasMeta) => {
    nav('/explore/' + c.id + (c.hit_page ? '?page=' + c.hit_page : ''))
  }

  const doCreate = async () => {
    try {
      const d = await createCanvas(titleInput.trim(), presetKey)
      setCreateOpen(false)
      setTitleInput('')
      nav('/explore/' + d.id)
    } catch {
      message.error('新建失败，请稍后再试')
    }
  }

  const openTrash = async () => {
    try { setTrash(await listTrash()) } catch { /* 空态即可 */ }
    setTrashOpen(true)
  }

  const doRestore = async (id: number) => {
    try {
      await restoreCanvas(id)
      setTrash(await listTrash())
      await refresh(query.trim())
    } catch { message.error('还原失败') }
  }

  const doArchive = (c: ExploreCanvasMeta) => {
    Modal.confirm({
      title: t('moveToTrash'),
      content: t('moveToTrashBody', { title: c.title }),
      okText: t('moveToTrash'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try { await archiveCanvas(c.id); await refresh(query.trim()) } catch { message.error('移除失败') }
      },
    })
  }

  const doRename = async () => {
    const t = renameVal.trim()
    if (!t || !renameId) return
    try {
      await renameCanvas(renameId, t)
      setRenameId(0)
      await refresh(query.trim())
    } catch { message.error('改名失败') }
  }

  const loadTpl = useCallback(async () => {
    setTplLoading(true)
    try { setTpls(await listTemplates()) } catch { /* 空态即可 */ } finally { setTplLoading(false) }
  }, [])

  const loadShares = useCallback(async () => {
    setSharesLoading(true)
    try { setShares(await listShares()) } catch { /* 空态即可 */ } finally { setSharesLoading(false) }
  }, [])

  // 分享列表的搜索/分页（数据源本身有 100 条上限+到期自动回收，前端轻量处理即可）：
  // 教师/管理员视图默认隐藏已过期——反正点开也是 410，留着只是噪音；学生保留（带清理按钮）
  const visibleShares = useMemo(() => {
    let r = shares
    if (!IS_STUDENT) r = r.filter((x) => !x.expired)
    const kw = shareQuery.trim()
    if (kw) r = r.filter((x) => (x.owner_name + x.owner_username + x.title).includes(kw))
    return r
  }, [shares, shareQuery, IS_STUDENT])
  const pagedShares = useMemo(() => visibleShares.slice((sharePage - 1) * 10, sharePage * 10), [visibleShares, sharePage])

  const onTab = (k: string) => {
    setTab(k)
    setSharePage(1)
    if (k === 'tpl') void loadTpl()
    if (k === 'shares') void loadShares()
  }

  const doUseTpl = async (id: number) => {
    try {
      const d = await applyTemplate(id)
      nav('/explore/' + d.canvas_id)
    } catch (e: any) { message.error(e?.response?.data?.detail || '使用失败') }
  }

  const doDeleteTpl = (id: number) => {
    Modal.confirm({
      title: t('tplDeleteConfirm'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try { await deleteTemplate(id); void loadTpl() } catch { message.error('下架失败') }
      },
    })
  }

  const doRevokeShare = async (id: number) => {
    try { await revokeShare(id); void loadShares() } catch { message.error('收回失败') }
  }

  const fmtTime = (s: string) => (s ? s.slice(5, 16) : '')

  const wallNode = (
    loading ? (
            <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
          ) : (
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
              gap: 16, padding: '8px 0',
            }}>
              {list.map((c) => {
                const thumb = thumbs[c.id]
                return (
                  <Card key={c.id} hoverable styles={{ body: { padding: 12 } }} onClick={() => openCanvas(c)}>
                    <div style={{
                      height: 96, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: PRESET_GRADIENT[c.preset_key] || PRESET_GRADIENT.blank, position: 'relative', overflow: 'hidden',
                    }}>
                      {thumb
                        ? <img src={authedFileUrl(thumb)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <span style={{ fontSize: 42 }}>{PRESET_EMOJI[c.preset_key] || '🖼️'}</span>}
                      <Dropdown
                        menu={{
                          items: [
                            { key: 'rename', label: t('rename') },
                            { key: 'del', label: t('moveToTrash'), danger: true },
                          ],
                          onClick: ({ key, domEvent }) => {
                            domEvent.stopPropagation()
                            if (key === 'rename') { setRenameId(c.id); setRenameVal(c.title) }
                            else if (key === 'del') doArchive(c)
                          },
                        }}
                        trigger={['click']}
                      >
                        <Button
                          size="small" type="text" icon={<MoreOutlined />}
                          style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(255,255,255,0.85)' }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </Dropdown>
                    </div>
                    <div style={{ marginTop: 8, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                      {!!c.hit_page && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t('hitTag', { page: c.hit_page })}</Tag>}
                    </div>
                    <div style={{
                      fontSize: 12, color: 'var(--text-secondary, #888)',
                      display: 'flex', justifyContent: 'space-between', marginTop: 4,
                    }}>
                      <span>{c.page_count || 0} 页</span>
                      <span>{fmtTime(c.updated_at)}</span>
                    </div>
                  </Card>
                )
              })}
              {list.length === 0 && <Empty description={query ? t('emptySearch') : t('emptyList')} style={{ gridColumn: '1 / -1' }} />}
            </div>
          )
  )

  const tplNode = (
    tplLoading ? (
      <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
    ) : (
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
        gap: 16, padding: '8px 0',
      }}>
        {tpls.map((tp) => (
          <Card key={tp.id} styles={{ body: { padding: 12 } }}>
            <div style={{
              height: 96, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: PRESET_GRADIENT.from_template, position: 'relative', overflow: 'hidden',
            }}>
              {tp.image_src
                ? <img src={authedFileUrl(tp.image_src)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ fontSize: 42 }}>📐</span>}
            </div>
            <div style={{ marginTop: 8, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tp.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 2 }}>
              {tp.publisher_name} · {t('tplUsedCount', { n: tp.use_count })}
            </div>
            <div style={{
              fontSize: 12, marginTop: 4, minHeight: 32,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{tp.description || ' '}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <Button size="small" type="primary" icon={<PlusSquareOutlined />} onClick={() => void doUseTpl(tp.id)}>{t('tplUse')}</Button>
              {tp.mine && <Button size="small" danger icon={<DeleteOutlined />} onClick={() => doDeleteTpl(tp.id)}>{t('tplDelete')}</Button>}
            </div>
          </Card>
        ))}
        {tpls.length === 0 && <Empty description={t('tplEmpty')} style={{ gridColumn: '1 / -1' }} />}
      </div>
    )
  )

  const shareNode = (
    sharesLoading ? (
      <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
    ) : shares.length === 0 ? (
      <Empty description={IS_STUDENT ? t('sharesEmptyMine') : t('sharesEmptyIn')} style={{ padding: 32 }} />
    ) : (
      <div style={{ padding: '4px 0' }}>
        <Input allowClear placeholder={t('sharesSearchPh')} value={shareQuery} style={{ width: 240, marginBottom: 8 }}
          onChange={(e) => { setShareQuery(e.target.value); setSharePage(1) }} />
        {pagedShares.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('sharesNoMatch')} style={{ padding: 24 }} />
        )}
        {pagedShares.map((x) => (
          <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid var(--border-color, #f0f0f0)' }}>
            {/* 分享封面缩略图：不点进查看页就能看清内容大概；悬停出大图，教师点击直达查看 */}
            {x.image_src ? (
              <Tooltip title={<img src={authedFileUrl(x.image_src)} alt="" style={{ maxWidth: 320, borderRadius: 6, display: 'block' }} />}
                mouseEnterDelay={0.3}>
                <img src={authedFileUrl(x.image_src)} alt=""
                  style={{
                    width: 88, height: 60, objectFit: 'cover', borderRadius: 6, flexShrink: 0,
                    border: '1px solid var(--border-color, #eee)',
                    cursor: !IS_STUDENT && !x.expired ? 'pointer' : 'default',
                  }}
                  onClick={() => { if (!IS_STUDENT && !x.expired) nav('/explore-share/' + x.id) }} />
              </Tooltip>
            ) : (
              <span style={{ fontSize: 20, width: 88, textAlign: 'center', flexShrink: 0 }}>🤝</span>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 2 }}>
                {IS_STUDENT
                  ? t('shareViews', { n: x.view_count }) + ' · ' + fmtTime(x.created_at) + ' → ' + fmtTime(x.expires_at)
                  : (x.owner_name || x.owner_username)
                    + (x.grade ? ' · ' + x.grade + (x.class ? ' ' + String(x.class) + t('classSuffix') : '') : '')
                    + ' · ' + t('shareViews', { n: x.view_count }) + ' · ' + fmtTime(x.created_at)}
                {x.expired && <Tag style={{ marginInlineStart: 6 }}>{t('shareExpiredTag')}</Tag>}
              </div>
            </div>
            {!x.expired && !IS_STUDENT && (
              <Button size="small" type="primary" onClick={() => nav('/explore-share/' + x.id)}>{t('shareOpen')}</Button>
            )}
            {!x.expired && IS_STUDENT && (
              <>
                <Button size="small" onClick={() => nav('/explore/' + x.canvas_id + '?page=' + x.page_number)}>{t('shareGoto')}</Button>
                <Button size="small" danger onClick={() => void doRevokeShare(x.id)}>{t('shareRevoke')}</Button>
              </>
            )}
            {x.expired && IS_STUDENT && (
              <Button size="small" danger onClick={() => void doRevokeShare(x.id)}>{t('shareClean')}</Button>
            )}
          </div>
        ))}
        {visibleShares.length > 10 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <Pagination current={sharePage} pageSize={10} total={visibleShares.length} size="small"
              hideOnSinglePage showTotal={(n) => t('sharesTotal', { n })} onChange={(p) => setSharePage(p)} />
          </div>
        )}
      </div>
    )
  )

  return (
    <div>
      <PageHeader
        icon={<span style={{ fontSize: 22 }}>🧭</span>}
        title={t('title')}
        subtitle={t('subtitle')}
        extra={
          <Space>
            <Input.Search allowClear placeholder={t('searchPh')} style={{ width: 200 }} onChange={(e) => setQuery(e.target.value)} />
            <Button icon={<RestOutlined />} onClick={openTrash}>{t('trash')}</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t('newCanvas')}</Button>
          </Space>
        }
      />

      <Tabs
        activeKey={tab}
        onChange={onTab}
        items={[
          { key: 'wall', label: t('tabWall'), children: wallNode },
          { key: 'tpl', label: t('tabTemplates'), children: tplNode },
          { key: 'shares', label: IS_STUDENT ? t('tabSharesMine') : t('tabSharesIn'), children: shareNode },
        ]}
      />

      <Modal title={t('createTitle')} open={createOpen} onOk={doCreate} onCancel={() => setCreateOpen(false)} okText={t('createOk')}>
        <Space orientation="vertical" style={{ width: '100%' }} size={10}>
          <Input
            placeholder={t('createNamePh')}
            value={titleInput}
            maxLength={60}
            onChange={(e) => setTitleInput(e.target.value)}
            onPressEnter={doCreate}
            autoFocus
          />
          <Select
            style={{ width: '100%' }}
            value={presetKey}
            onChange={setPresetKey}
            options={[
              { value: 'blank', label: t('tplBlank') },
              { value: 'question_pile', label: t('tplQuestion') },
              { value: 'doodle', label: t('tplDoodle') },
              { value: 'explore_notes', label: t('tplNotes') },
              { value: 'lesson_inspo', label: t('tplLesson') },
              { value: 'asset_workshop', label: t('tplWorkshop') },
              { value: 'self_training', label: t('tplTraining') },
            ]}
          />
        </Space>
      </Modal>

      <Modal title={t('rename')} open={renameId > 0} onOk={doRename} onCancel={() => setRenameId(0)}>
        <Input value={renameVal} maxLength={60} onChange={(e) => setRenameVal(e.target.value)} onPressEnter={doRename} autoFocus />
      </Modal>

      <Modal title={t('trashTitle')} open={trashOpen} footer={null} onCancel={() => setTrashOpen(false)}>
        {trash.length === 0 ? (
          <Empty description={t('trashEmpty')} />
        ) : (
          trash.map((c) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border-color, #f0f0f0)' }}>
              <span style={{ fontSize: 20, marginRight: 8 }}>{PRESET_EMOJI[c.preset_key] || '🖼️'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{c.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>{t('trashRowHint', { time: fmtTime(c.updated_at) })}</div>
              </div>
              <Button size="small" type="primary" onClick={() => void doRestore(c.id)}>{t('restore')}</Button>
            </div>
          ))
        )}
      </Modal>
    </div>
  )
}

export default ExploreCanvasPage