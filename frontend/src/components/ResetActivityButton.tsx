/**
 * 活动数据重置按钮
 *
 * 与"删除"的区别：删除会连活动本体一起消失；重置只清空学生参与产生的数据
 * （答卷/提交/投票/发言/积分流水…），活动题目、选项、配置、房间码、任务 ID 全部保留，
 * 并可把活动状态回滚到"可重新参与"。操作不可撤销，因此强制走
 * "后端干跑预览 -> 勾选选项 -> 输入活动名称确认"三段式。
 */
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert, Button, Checkbox, Descriptions, Divider, Input, Modal, Space, Spin, Table, Tag, Tooltip, Typography, message,
} from 'antd';
import { UndoOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  findScope, getResetScopes, previewReset, resetActivity, resetErrorInfo,
} from '../api/activityReset';
import type {
  DeletedRow, ResetErrorInfo, ResetPreview, ResetResult, ResetScope, ResetTargetRow, ResetTextItem,
} from '../api/activityReset';
import { useAuthStore } from '../stores/authStore';

const { Text } = Typography;

interface Props {
  activityType: string;
  activityId: string | number;
  /** 预览加载前用于占位显示；真正的校验标题以后端返回为准 */
  activityTitle?: string;
  size?: 'small' | 'middle' | 'large';
  onSuccess?: () => void;
  /** 图标态：操作列普遍使用纯图标按钮的页面用，中文说明放进悬浮提示 */
  iconOnly?: boolean;
  /** 所在表格行可点击展开时，阻止事件冒泡 */
  stopPropagation?: boolean;
}

const ResetActivityButton: React.FC<Props> = ({
  activityType, activityId, activityTitle = '', size = 'small', onSuccess,
  iconOnly = false, stopPropagation = false,
}) => {
  const role = useAuthStore((s) => s.user?.role);
  const { t } = useTranslation('dashboard');

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [scope, setScope] = useState<ResetScope | null>(null);
  const [opts, setOpts] = useState<Record<string, boolean>>({});
  const [notify, setNotify] = useState(true);
  const [force, setForce] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<ResetErrorInfo | null>(null);
  const [result, setResult] = useState<ResetResult | null>(null);
  const gen = useRef(0);

  /** i18n 优先，缺失时回退后端中文文案（后端是唯一事实源，新增类型不至于开天窗）
   *  opts 交给 i18next 做 {{var}} 插值：不传参数就不会留下半截占位符 */
  const tr = useCallback((key: string, fallback: string, opts?: Record<string, unknown>) => {
    const v = opts ? t(key, opts) : t(key);
    return (v === key || v === '') ? fallback : v;
  }, [t]);

  const runPreview = useCallback(async (options: Record<string, boolean>) => {
    const my = ++gen.current;
    setLoading(true);
    setError(null);
    try {
      const p = await previewReset(activityType, activityId, options);
      if (my !== gen.current) return;
      setPreview(p);
      setOpts(p.options_effective || {});
    } catch (e) {
      if (my === gen.current) setError(resetErrorInfo(e));
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, [activityType, activityId]);

  const handleOpen = useCallback(async () => {
    setOpen(true);
    setResult(null);
    setConfirm('');
    setForce(false);
    setNotify(true);
    setError(null);
    setPreview(null);
    setLoading(true);
    try {
      const [scopes, p] = await Promise.all([
        getResetScopes().catch(() => [] as ResetScope[]),
        previewReset(activityType, activityId, {}),
      ]);
      setScope(findScope(scopes, activityType));
      setPreview(p);
      setOpts(p.options_effective || {});
    } catch (e) {
      setError(resetErrorInfo(e));
    } finally {
      setLoading(false);
    }
  }, [activityType, activityId]);

  const toggleOption = useCallback((key: string, val: boolean) => {
    const next = { ...opts, [key]: val };
    setOpts(next);
    setResult(null);
    void runPreview(next);        // 换了选项就要重算，保证"看到的数字=会删的数字"
  }, [opts, runPreview]);

  const doReset = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await resetActivity(activityType, activityId, {
        options: opts, force, notify_students: notify,
        // 确认口令交给服务端校验，前端这道 disabled 只是少一次往返
        confirm_text: confirm,
      });
      setResult(res);
      message.success(t('activityMonitor.reset.done', {
        rows: res.deleted_total, points: res.rewards_points, students: res.students_affected,
      }));
      onSuccess?.();
    } catch (e) {
      setError(resetErrorInfo(e));
      // 409 只可能由"活动进行中"触发，直接勾上强制项，省一次往返
      if ((e as { response?: { status?: number } })?.response?.status === 409) setForce(true);
    } finally {
      setSubmitting(false);
    }
  }, [activityType, activityId, opts, force, notify, confirm, onSuccess, t]);

  if (role !== 'admin' && role !== 'teacher') return null;

  const btnLabel = t('activityMonitor.reset.button');
  const resetBtn = (
    <Button size={size} danger icon={<UndoOutlined />}
            onClick={(e) => { if (stopPropagation) e.stopPropagation(); void handleOpen(); }}>
      {iconOnly ? null : btnLabel}
    </Button>
  );

  // 规则一律来自服务端 policy：要不要强制确认、要不要输入口令、有没有东西可删
  const pol = preview?.policy;
  // 确认口令 / 展示的标题都以服务端算好的纯文本标题为准，界面不参与任何加工
  const title = pol?.confirmation_expected || preview?.activity?.title_plain
    || preview?.activity?.title || activityTitle || '';
  const inProgress = !!pol?.requires_force;
  const nothingToDo = !!pol?.nothing_to_do;
  const needConfirm = pol?.requires_confirmation !== false;   // 后端没说不要，就要
  const canSubmit = !!preview && !loading && !result && !nothingToDo
    && (!inProgress || force)
    && (!needConfirm || confirm.trim() === (pol?.confirmation_expected ?? ''));

  /** 状态枚举 -> 界面文案：复用活动列表页既有的 activityMonitor.status.* 词表，
   *  保证同一枚举在列表与弹窗里措辞一致；查不到才回退后端中文 */
  const sv = (raw?: string, fallback?: string) => (
    raw ? tr(`activityMonitor.status.${raw}`, fallback || raw) : ''
  );

  /** 活动类型名：词典键由服务端下发（不再在前端维护 snake_case -> camelCase 映射） */
  const tv = useCallback((i18nKey: string, fallback: string) =>
    tr(`activityMonitor.activityType.${i18nKey}`, fallback), [tr]);

  /** 后端 {code,msg,params} 错误 -> 界面文案：优先 err.<code>，中文 msg 只做兜底 */
  const errText = useCallback((e: ResetErrorInfo) => {
    if (!e.code) return e.msg || t('activityMonitor.reset.failed');
    const p: Record<string, unknown> = { ...e.params };
    // 服务端在 params.type 里直接给词典键，这里只做一次查表
    if (typeof p.type === 'string' && p.type) p.type = tv(p.type, p.type);
    if (typeof p.label_code === 'string' && p.label_code) {
      p.label = tr(`activityMonitor.reset.inProgressLabel.${p.label_code}`, String(p.label || ''));
    }
    return tr(`activityMonitor.reset.err.${e.code}`, e.msg || t('activityMonitor.reset.failed'), p);
  }, [t, tr, tv]);

  /** 后端 {code,text,params} 警告 -> 界面文案，同上 */
  const warnText = useCallback((w: ResetTextItem) => {
    const p: Record<string, unknown> = { ...(w.params || {}) };
    if (typeof p.label_code === 'string' && p.label_code) {
      p.label = tr(`activityMonitor.reset.inProgressLabel.${p.label_code}`, String(p.label || ''));
    }
    return tr(`activityMonitor.reset.warn.${w.code}`, w.text, p);
  }, [tr]);

  /** 数据库表名收进悬浮提示，界面正文只出现人类可读的数据项名称 */
  const nameLabel = (table: string, zh: string) => (
    <Tooltip title={`${t('activityMonitor.reset.colTable')}: ${table}`}>
      <span>{tr(`activityMonitor.reset.table.${table}`, zh)}</span>
    </Tooltip>
  );

  const targetColumns: ColumnsType<ResetTargetRow> = [
    { title: t('activityMonitor.reset.colItem'), dataIndex: 'label', key: 'label',
      render: (v: string, r) => nameLabel(r.table, v) },
    { title: t('activityMonitor.reset.colRows'), dataIndex: 'count', key: 'count',
      width: 140, align: 'right',
      render: (v: number) => <Text strong type={v ? 'danger' : 'secondary'}>{v}</Text> },
  ];

  return (
    <>
      {iconOnly ? (
        <Tooltip title={t('activityMonitor.reset.button')}>
          {resetBtn}
        </Tooltip>
      ) : resetBtn}
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        width={760}
        mask={{ closable: false }}
        destroyOnHidden
        title={<Space><UndoOutlined style={{ color: '#ff4d4f' }} />{t('activityMonitor.reset.title')}</Space>}
        okText={result ? t('activityMonitor.reset.closeBack') : t('activityMonitor.reset.confirmBtn')}
        cancelButtonProps={result ? { style: { display: 'none' } } : undefined}
        okButtonProps={{ danger: true, disabled: result ? false : !canSubmit, loading: submitting }}
        onOk={() => { if (result) { setOpen(false); return; } void doReset(); }}
      >
        <Spin spinning={loading}>
          {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={errText(error)} />}

          {!result && preview && (
            <>
              <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                     message={t('activityMonitor.reset.warning')}
                     description={t('activityMonitor.reset.warningDesc')} />

              <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}
                items={[
                  { key: 'name', label: t('activityMonitor.reset.activity'),
                    children: <Space><Tag color="blue">{tv(preview.activity.type_i18n_key || preview.activity.type, preview.activity.type_label)}</Tag><Text strong>{preview.activity.title_plain || preview.activity.title}</Text></Space> },
                  { key: 'meta', label: t('activityMonitor.reset.belong'),
                    children: [
                      preview.activity.creator_name || preview.activity.creator || '-',
                      sv(preview.activity.status, preview.activity.status_label) || '-',
                    ].join(' / ') },
                  { key: 'keep', label: t('activityMonitor.reset.keepTitle'),
                    children: (
                      <Space size={[4, 4]} wrap>
                        {(scope?.keep_content || []).map((k) => (
                          <Tag color="success" key={k.key}>{tr(`activityMonitor.reset.keep.${k.key}`, k.label)}</Tag>
                        ))}
                        {!(scope?.keep_content || []).length && <Text type="secondary">-</Text>}
                      </Space>
                    ) },
                ]} />

              <Table<ResetTargetRow> size="small" rowKey={(r) => `${r.db}:${r.table}`} pagination={false}
                    columns={targetColumns} dataSource={preview.targets}
                    summary={() => (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0}>
                          <Space size={4} wrap>
                            <Text strong>{t('activityMonitor.reset.derived')}</Text>
                            <Tag>{t('activityMonitor.reset.rewardsRows', { n: preview.rewards.rows })}</Tag>
                            <Tag>{t('activityMonitor.reset.notifyRows', { n: preview.notifications })}</Tag>
                            {preview.wrong_book > 0 && <Tag>{t('activityMonitor.reset.wrongRows', { n: preview.wrong_book })}</Tag>}
                          </Space>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={1} align="right">
                          <Text strong type="danger">{preview.total_rows}</Text>
                        </Table.Summary.Cell>
                      </Table.Summary.Row>
                    )} />

              <Divider style={{ margin: '12px 0' }} />
              <Space size="large" wrap>
                <Text>{t('activityMonitor.reset.students', { n: preview.students_affected })}</Text>
                {preview.rewards.points > 0 && (
                  <Text type="danger">{t('activityMonitor.reset.points', { points: preview.rewards.points })}</Text>
                )}
                {preview.status_reset?.will_change && (
                  <Text>{t('activityMonitor.reset.status', {
                    from: sv(preview.status_reset.from, preview.status_reset.from_label),
                    to: sv(preview.status_reset.to, preview.status_reset.to_label),
                  })}</Text>
                )}
              </Space>

              {(scope?.options || []).length > 0 && (
                <>
                  <Divider orientation="left" plain style={{ margin: '12px 0 8px' }}>
                    {t('activityMonitor.reset.options')}
                  </Divider>
                  <Space direction="vertical">
                    {(scope?.options || []).map((o) => (
                      <Checkbox key={o.key} checked={!!opts[o.key]}
                                onChange={(e) => toggleOption(o.key, e.target.checked)}>
                        {tr(`activityMonitor.reset.option.${o.key}`, o.label)}
                      </Checkbox>
                    ))}
                    <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)}>
                      {t('activityMonitor.reset.option.notify_students')}
                    </Checkbox>
                  </Space>
                </>
              )}

              {preview.status_reset && !preview.status_reset.will_change && !!preview.status_reset.from && (
                <Alert type="info" showIcon style={{ marginBottom: 8 }}
                       message={t('activityMonitor.reset.statusKeep', {
                         status: sv(preview.status_reset.from, preview.status_reset.from_label),
                       })} />
              )}

              {preview.warnings.length > 0 && (
                <Space direction="vertical" style={{ width: '100%', marginTop: 12 }}>
                  {preview.warnings.map((w) => (
                    <Alert key={w.code || w.text} type="error" showIcon message={warnText(w)} />
                  ))}
                </Space>
              )}
              {inProgress && (
                <Checkbox style={{ marginTop: 12 }} checked={force}
                          onChange={(e) => setForce(e.target.checked)}>
                  {t('activityMonitor.reset.forceConfirm', { n: preview.in_progress.count })}
                </Checkbox>
              )}
              {nothingToDo && (
                <Alert style={{ marginTop: 12 }} type="success" showIcon
                       message={t('activityMonitor.reset.nothing')} />
              )}

              {/* 是否需要输入确认口令由服务端 policy 决定（无名活动不该被卡死） */}
              {needConfirm && (
                <>
                  <Divider style={{ margin: '16px 0 8px' }} />
                  <Text>{t('activityMonitor.reset.typeToConfirm', { title })}</Text>
                  <Input style={{ marginTop: 8 }} value={confirm}
                         placeholder={t('activityMonitor.reset.typePlaceholder')}
                         onChange={(e) => setConfirm(e.target.value)} />
                </>
              )}
            </>
          )}

          {result && (
            <>
              <Alert type="success" showIcon style={{ marginBottom: 12 }}
                     message={t('activityMonitor.reset.doneTitle')}
                     description={t('activityMonitor.reset.doneDesc', {
                       rows: result.deleted_total, points: result.rewards_points,
                       students: result.students_affected, notified: result.notified_students,
                     })} />
              <Table size="small" rowKey={(r) => `${r.db}:${r.table}`} pagination={false}
                     dataSource={result.deleted}
                     columns={[
                       { title: t('activityMonitor.reset.colItem'), dataIndex: 'table', key: 'table',
                         render: (v: string, r: DeletedRow) => nameLabel(v, r.label) },
                       { title: t('activityMonitor.reset.colRows'), dataIndex: 'rows', key: 'rows', width: 140, align: 'right' },
                     ]} />
              {result.status_reset && !('unchanged' in result.status_reset && result.status_reset.unchanged) && (
                <Text style={{ display: 'block', marginTop: 8 }}>
                  {t('activityMonitor.reset.status', {
                    from: sv(result.status_reset.from, result.status_reset.from_label),
                    to: sv(result.status_reset.to, result.status_reset.to_label),
                  })}
                </Text>
              )}
            </>
          )}
        </Spin>
      </Modal>
    </>
  );
};

export default ResetActivityButton;
