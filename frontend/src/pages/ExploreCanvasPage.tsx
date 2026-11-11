/** 探索画布 · 列表页：卡片墙（悬停菜单 / 真实缩略图 / 搜索直达命中页）+ 新建 + 回收站 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Dropdown, Empty, Input, Modal, Pagination, Popconfirm, Select, Space, Spin, Tabs, Tag, Tooltip, message } from 'antd'
import { DeleteOutlined, MoreOutlined, PlusOutlined, PlusSquareOutlined, RestOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import PageHeader from '../components/PageHeader'
import { useAuthStore } from '../stores/authStore'
import { authedFileUrl } from '../api/client'
import { BUILTIN_TEMPLATES, type BuiltinTemplate } from '../constants/exploreTemplates'
import {
  archiveCanvas, createCanvas, deleteArchive, deleteTemplate, listArchives, listCanvases, listShares, listTemplates, listTrash, renameCanvas, restoreCanvas, revokeShare, applyTemplate,
  type ArchiveItem, type ExploreCanvasMeta, type ShareMeta, type TemplateMeta,
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

const PAGE_SIZE = 12

const ExploreCanvasPage: React.FC = () => {
  const nav = useNavigate()
  const { t } = useTranslation('explore')
  const IS_STUDENT = useAuthStore((s) => s.user?.role) === 'student'
  const [list, setList] = useState<ExploreCanvasMeta[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const thumbLoadedRef = useRef(false)
  const [query, setQuery] = useState('')
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  // 成长档案（「存入档案」的出口）
  const [archives, setArchives] = useState<ArchiveItem[]>([])
  const [archLoading, setArchLoading] = useState(false)
  const [archView, setArchView] = useState<ArchiveItem | null>(null)
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

  const refresh = useCallback(async (q = '', p = 1) => {
    try {
      const r = await listCanvases(q, PAGE_SIZE, (p - 1) * PAGE_SIZE)
      // 归档/删除最后一页的最后一项后，页码要回退，否则停在一张空白页上
      if (!r.canvases.length && p > 1 && r.total > 0) { setPage(p - 1); return }
      setList(r.canvases)
      setTotal(r.total)
      // 归档只拉一次并缓存：卡片封面与「我的档案」共用这份数据，搜索/翻页不重复请求
      if (!thumbLoadedRef.current) {
        thumbLoadedRef.current = true
        const arch = await listArchives().catch(() => [])
        setArchives(arch)
        const map: Record<number, string> = {}
        for (const a of arch) {
          if (a.image_src && !map[a.canvas_id]) map[a.canvas_id] = a.image_src
        }
        setThumbs(map)
      }
    } catch {
      message.error(t('listLoadFail'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const ms = window.setTimeout(() => { void refresh(query.trim(), page) }, 350)
    return () => window.clearTimeout(ms)
  }, [query, page, refresh])

  const openCanvas = (c: ExploreCanvasMeta) => {
    nav('/explore/' + c.id + (c.hit_page ? '?page=' + c.hit_page : ''))
  }

  const doCreate = async () => {
    try {
      const d = await createCanvas(titleInput.trim(), presetKey)
      setCreateOpen(false)
      setTitleInput('')
      nav('/explore/' + d.id)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('createFail'))
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
      await refresh(query.trim(), page)
    } catch { message.error(t('restoreFail')) }
  }

  const doArchive = (c: ExploreCanvasMeta) => {
    Modal.confirm({
      title: t('moveToTrash'),
      content: t('moveToTrashBody', { title: c.title }),
      okText: t('moveToTrash'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try { await archiveCanvas(c.id); await refresh(query.trim(), page) } catch { message.error(t('archiveFail')) }
      },
    })
  }

  const doRename = async () => {
    const nextTitle = renameVal.trim()
    if (!nextTitle || !renameId) return
    try {
      await renameCanvas(renameId, nextTitle)
      setRenameId(0)
      await refresh(query.trim(), page)
    } catch { message.error(t('renameFail')) }
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

  const loadArchives = useCallback(async () => {
    setArchLoading(true)
    try {
      const arch = await listArchives()
      setArchives(arch)
      const map: Record<number, string> = {}
      for (const a of arch) {
        if (a.image_src && !map[a.canvas_id]) map[a.canvas_id] = a.image_src
      }
      setThumbs(map)
      thumbLoadedRef.current = true
    } catch { /* 空态即可 */ } finally { setArchLoading(false) }
  }, [])

  const onTab = (k: string) => {
    setTab(k)
    setSharePage(1)
    if (k === 'tpl') void loadTpl()
    if (k === 'shares') void loadShares()
    if (k === 'arch') void loadArchives()
  }

  const useBuiltin = async (tpl: BuiltinTemplate) => {
    try {
      const d = await createCanvas(tpl.defaultTitle, 'from_template')
      nav('/explore/' + d.id + '?seed=' + tpl.id)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('createFail'))
    }
  }

  const doUseTpl = async (id: number) => {
    try {
      const d = await applyTemplate(id)
      nav('/explore/' + d.canvas_id)
    } catch (e: any) { message.error(e?.response?.data?.detail || t('tplUseFail')) }
  }

  const doDeleteTpl = (id: number) => {
    Modal.confirm({
      title: t('tplDeleteConfirm'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try { await deleteTemplate(id); void loadTpl() } catch { message.error(t('tplUnpublishFail')) }
      },
    })
  }

  // 从成长档案移除一条：只删档案记录，画布那一页与时间线都不动
  const doDropArchive = async (a: ArchiveItem) => {
    const rest = archives.filter((x) => x.id !== a.id)
    try {
      await deleteArchive(a.id)
      setArchives(rest)
      const map: Record<number, string> = {}
      for (const x of rest) {
        if (x.image_src && !map[x.canvas_id]) map[x.canvas_id] = x.image_src
      }
      setThumbs(map)
      message.success(t('archDropped'))
    } catch { message.error(t('archDropFail')) }
  }

  const doRevokeShare = async (id: number) => {
    try { await revokeShare(id); void loadShares() } catch { message.error(t('shareRevokeFail')) }
  }

  const fmtTime = (s: string) => (s ? s.slice(5, 16) : '')

  // 「我的档案」：存入成长档案的作品在这里能翻出来看/下载/回到那一页——
  // 之前这些记录只被拿来当卡片封面，学生存完找不到东西，等于没有出口。
  const archNode = archLoading && !archives.length ? (
    <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
  ) : archives.length === 0 ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('archEmptyList')} style={{ padding: 32 }} />
  ) : (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
      gap: 14, padding: '8px 0',
    }}>
      {archives.map((a) => (
        <Card key={a.id} size="small" hoverable={!!a.image_src} styles={{ body: { padding: 10 } }}
          onClick={() => { if (a.image_src) setArchView(a) }}>
          <div style={{
            height: 116, borderRadius: 8, overflow: 'hidden', background: '#f7f9fc',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {a.image_src
              ? <img src={authedFileUrl(a.image_src)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              : <span style={{ fontSize: 30, color: '#c3cbd8' }}>🖼️</span>}
          </div>
          <div style={{ marginTop: 8, fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {a.title}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 2 }}>
            {a.canvas_title} · {fmtTime(a.created_at)}
          </div>
          {!!a.summary && (
            <div style={{
              fontSize: 12, marginTop: 4, color: 'var(--text-secondary, #667)', display: '-webkit-box',
              WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{a.summary}</div>
          )}
          <Space size={6} style={{ marginTop: 8 }} wrap>
            {!!a.image_src && <Button size="small" onClick={(e) => { e.stopPropagation(); setArchView(a) }}>{t('archView')}</Button>}
            {!!a.image_src && (
              <Button size="small" href={authedFileUrl(a.image_src)} download={a.title + '.png'}
                onClick={(e) => e.stopPropagation()}>{t('archDownload')}</Button>
            )}
            <Button size="small" type="text"
              onClick={(e) => { e.stopPropagation(); nav('/explore/' + a.canvas_id + '?page=' + a.page_number) }}>
              {t('archGoto')}
            </Button>
            <Popconfirm title={t('archDropConfirm')} description={t('archDropBody')} okText={t('archDropOk')}
              onConfirm={() => void doDropArchive(a)}>
              <Button size="small" type="text" danger onClick={(e) => e.stopPropagation()}>{t('archDrop')}</Button>
            </Popconfirm>
          </Space>
        </Card>
      ))}
    </div>
  )

  const wallNode = (
    loading ? (
            <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
          ) : (
            <div className="explore-wall" style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
              gap: 16, padding: '8px 0',
            }}>
              {list.map((c) => {
                const thumb = c.cover_src || thumbs[c.id]
                return (
                  <Card key={c.id} hoverable styles={{ body: { padding: 12 } }} onClick={() => openCanvas(c)}>
                    <div className="explore-thumb" style={{
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
                    <div className="explore-meta" style={{ marginTop: 8, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                      {!!c.hit_page && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t('hitTag', { page: c.hit_ordinal ?? c.hit_page })}</Tag>}
                    </div>
                    <div className="explore-submeta" style={{
                      fontSize: 12, color: 'var(--text-secondary, #888)',
                      display: 'flex', justifyContent: 'space-between', marginTop: 4,
                    }}>
                      <span>{c.page_count ? t('pagesCount', { n: c.page_count }) : t('pagesBlank')}</span>
                      <span>{fmtTime(c.updated_at)}</span>
                    </div>
                  </Card>
                )
              })}
              {list.length === 0 && <Empty description={query ? t('emptySearch') : t('emptyList')} style={{ gridColumn: '1 / -1' }} />}
              {/* 分页：画布多起来后不再一次渲染全部卡片 */}
              {total > PAGE_SIZE && (
                <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
                  <Pagination current={page} pageSize={PAGE_SIZE} total={total} size="small"
                    showSizeChanger={false} hideOnSinglePage onChange={(p) => setPage(p)} />
                </div>
              )}
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
        {BUILTIN_TEMPLATES.map((tp) => (
          <Card key={tp.id} styles={{ body: { padding: 12 } }}>
            <div style={{
              height: 96, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: PRESET_GRADIENT.from_template, position: 'relative', overflow: 'hidden',
            }}>
              <span style={{ fontSize: 42 }}>{tp.emoji}</span>
              <Tag color="blue" style={{ position: 'absolute', top: 6, right: 6 }}>{t('tplOfficial')}</Tag>
            </div>
            <div style={{ marginTop: 8, fontWeight: 600 }}>{t(tp.titleKey)}</div>
            <div style={{
              fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 2, minHeight: 32,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{t(tp.descKey)}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <Button size="small" type="primary" icon={<PlusSquareOutlined />} onClick={() => void useBuiltin(tp)}>{t('tplUse')}</Button>
            </div>
          </Card>
        ))}
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
        {tpls.length === 0 && (
          <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--text-tertiary, #999)', padding: '4px 2px' }}>
            {t('tplEmptyHint')}
          </div>
        )}
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
          /* 内层 Space 必须 wrap：外层 PageHeader 把 extra 当一个整体，
             「搜索200 + 回收站 + 新建画布」不换行实测排到 459px（视口 390），
             手机上「新建画布」整颗按钮掉到屏外，只剩一个「+」。 */
          <Space wrap size={8}>
            <Input.Search allowClear placeholder={t('searchPh')} style={{ width: 200, maxWidth: '100%' }}
              onChange={(e) => { setQuery(e.target.value); setPage(1) }} />
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
          { key: 'arch', label: t('tabArchives'), children: archNode },
          { key: 'tpl', label: t('tabTemplates'), children: tplNode },
          { key: 'shares', label: IS_STUDENT ? t('tabSharesMine') : t('tabSharesIn'), children: shareNode },
        ]}
      />

      <Modal open={!!archView} title={archView?.title} footer={null} onCancel={() => setArchView(null)} width={760}>
        {!!archView?.image_src && (
          <img src={authedFileUrl(archView.image_src)} alt="" style={{ width: '100%', borderRadius: 8, display: 'block' }} />
        )}
        {!!archView?.summary && (
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{archView.summary}</div>
        )}
      </Modal>

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