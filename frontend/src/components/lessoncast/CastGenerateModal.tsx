/**
 * 生成 / 编辑 AI 讲演的弹窗（两步式）。
 *
 * 新建：选档位与风格 → 出文字大纲 → 确认后合成音频。
 * 编辑：知识点已有讲演时直接进大纲，改完可整篇重合成，也可「仅重合成这一页」。
 *
 * 两步分开的唯一理由是成本：TTS 按字符计费，一步到底会让每次修改都白烧一遍音频钱。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Radio, Select, Spin, message } from 'antd';
import {
  createCastOutline,
  getCastMeta,
  getCastOutline,
  publishCast,
  regenCastPage,
  saveCastOutline,
  synthesizeCastAudio,
  type CastMeta,
  type CastPage,
  type SpeakerMode,
} from '../../api/lessonCast';
import { OutlineEditor } from './OutlineEditor';

interface CastGenerateModalProps {
  open: boolean;
  kp: { id: number; name: string; description: string; learning_objectives: string } | null;
  onClose: () => void;
  /** 生成或更新完成并发布后调用，通常用来跳到播放页 */
  onDone: (kpId: number) => void;
}

type Step = 'form' | 'outline' | 'syncing';

export function CastGenerateModal({ open, kp, onClose, onDone }: CastGenerateModalProps) {
  const [meta, setMeta] = useState<CastMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [minutes, setMinutes] = useState(5);
  const [mode, setMode] = useState<SpeakerMode>('duo');
  const [desc, setDesc] = useState('');
  const [needDesc, setNeedDesc] = useState(false);

  const [step, setStep] = useState<Step>('form');
  const [castId, setCastId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [pages, setPages] = useState<CastPage[]>([]);
  const [hasAudio, setHasAudio] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mode2, setMode2] = useState<SpeakerMode>('duo');   // 已加载讲演的真实风格
  const [nameA, setNameA] = useState('老师');
  const [nameB, setNameB] = useState('同学');

  const [busy, setBusy] = useState(false);
  const [regenIdx, setRegenIdx] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [tip, setTip] = useState('');

  const originalRef = useRef<string>('');

  useEffect(() => {
    if (!open || !kp) return;
    setStep('form');
    setCastId(null);
    setPages([]);
    setHasAudio(false);
    setDirty(false);
    setErr('');
    setTip('');
    setBusy(false);
    setRegenIdx(null);
    setDesc('');
    setNeedDesc(!kp.description && !kp.learning_objectives);

    setMetaLoading(true);
    getCastMeta(kp.id)
      .then(async (m) => {
        setMeta(m);
        setMinutes(m.default_minutes || 5);
        // 已有讲演 → 直接进编辑（老师最常见的动作是改一句口误，不是从零再来）
        const existing = m.has_cast?.duo || m.has_cast?.single;
        if (!existing) return;
        try {
          const o = await getCastOutline(existing.id);
          setCastId(o.cast_id);
          setTitle(o.title);
          setPages(o.pages);
          setMode2(o.speaker_mode);
          setNameA(o.name_a || '老师');
          setNameB(o.name_b || '同学');
          setHasAudio(o.status !== 'draft');
          originalRef.current = JSON.stringify(o.pages);
          setStep('outline');
        } catch {
          // 取不到就当成新建，不阻断
        }
      })
      .catch(() => { /* 元信息失败不挡生成，用默认值 */ })
      .finally(() => setMetaLoading(false));
  }, [open, kp]);

  const updatePages = (next: CastPage[]) => {
    setPages(next);
    setDirty(JSON.stringify(next) !== originalRef.current);
  };

  const totalLines = useMemo(
    () => pages.reduce((s, p) => s + (p.lines?.length || 0), 0),
    [pages],
  );

  const doOutline = async () => {
    if (!kp) return;
    if (needDesc && !desc.trim()) {
      message.warning('请先用一句话说明这个知识点讲什么');
      return;
    }
    setBusy(true);
    setErr('');
    setTip('');
    try {
      const res = await createCastOutline(kp.id, {
        minutes,
        speaker_mode: mode,
        description: desc.trim() || undefined,
      });
      setCastId(res.cast_id);
      setTitle(res.title);
      setPages(res.pages);
      setMode2(res.speaker_mode);
      setNameA(res.name_a || '老师');
      setNameB(res.name_b || '同学');
      setHasAudio(false);
      setDirty(false);
      originalRef.current = JSON.stringify(res.pages);
      setStep('outline');
    } catch (e: any) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail;
      if (status === 409 && (detail?.code === 'need_description' || detail === 'need_description')) {
        setNeedDesc(true);
        setErr('请先用一句话说明这个知识点讲什么');
      } else {
        setErr(typeof detail === 'string' ? detail : '大纲生成失败，请重试');
      }
    } finally {
      setBusy(false);
    }
  };

  /** 合成整篇：先保存改动，再按需合成，最后发布 */
  const doAudio = async () => {
    if (!castId) return;
    setBusy(true);
    setErr('');
    setTip('');
    let needAudio = !hasAudio;
    try {
      if (dirty) {
        const saved = await saveCastOutline(castId, { pages, title });
        needAudio = saved.need_audio || !hasAudio;
        originalRef.current = JSON.stringify(pages);
        setDirty(false);
      }
      if (needAudio) {
        setStep('syncing');
        const res = await synthesizeCastAudio(castId);
        if (res?.error) throw new Error(res.error);
      }
      try {
        await publishCast(castId);
      } catch (e: any) {
        const detail = e?.response?.data?.detail;
        setErr(typeof detail === 'string' ? detail : '音频已就绪，但自动发布失败，请稍后重试');
      }
      message.success(needAudio ? '讲演已生成，学生可以看了' : '已保存，内容没有变化，无需重新合成');
      if (kp) onDone(kp.id);
      onClose();
    } catch (e: any) {
      setErr(e?.message || '合成失败，请重试');
      setStep('outline');
    } finally {
      setBusy(false);
    }
  };

  /** 只重合成一页：先存整篇（后端会挡住"其它页也改了"的情况），再重录这一页 */
  const doRegenPage = async (idx: number) => {
    if (!castId) return;
    setRegenIdx(idx);
    setErr('');
    setTip('');
    try {
      const saved = await saveCastOutline(castId, { pages, title });
      if (saved.need_audio) {
        // 除本页外还有别的页改了：后端 regen 也会拒，这里先给出可读提示
        setErr('其它页也改过了，请用「保存并更新」整篇重新合成');
        return;
      }
      const res = await regenCastPage(castId, idx, (pages[idx].lines || []).map((l) => ({
        speaker: l.speaker, text: l.text,
      })));
      if (res?.error) throw new Error(res.error);
      originalRef.current = JSON.stringify(pages);
      setDirty(false);
      setTip(`第 ${idx + 1} 页已重新合成，其它页的音频没有重做。`);
      message.success(`第 ${idx + 1} 页已更新`);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setErr(typeof detail === 'string' ? detail : (e?.message || '该页重合成失败'));
    } finally {
      setRegenIdx(null);
    }
  };

  const resetToForm = () => {
    setStep('form');
    setCastId(null);
    setPages([]);
    setHasAudio(false);
    setDirty(false);
    setErr('');
    setTip('');
    setMinutes(meta?.default_minutes || 5);
  };

  return (
    <Modal
      open={open}
      title={`AI 讲演 · ${kp?.name || ''}`}
      onCancel={() => { if (!busy) onClose(); }}
      maskClosable={!busy}
      footer={null}
      width={step === 'outline' ? 760 : 620}
      destroyOnHidden
    >
      {metaLoading && !meta ? (
        <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
      ) : (
        <>
          {meta && !meta.tts_enabled ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="语音合成未启用，AI 讲演不可用"
              description="请到「系统配置 → AI 与模型 → 语音合成」打开总开关（与 AI 播客共用同一个总闸）"
            />
          ) : null}

          {err ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={err} /> : null}
          {tip ? <Alert type="success" showIcon style={{ marginBottom: 12 }} message={tip} /> : null}

          {step === 'form' && (
            <>
              {castId ? (
                <Alert
                  type="info" showIcon style={{ marginBottom: 12 }}
                  message="重新生成会替换这一版讲演"
                  description="档位或风格变了才需要重新出稿；只想改一两句话，请用「返回编辑」。"
                  action={<Button size="small" onClick={() => setStep('outline')}>返回编辑</Button>}
                />
              ) : null}

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
                <label style={{ fontSize: 13 }}>
                  <div style={{ marginBottom: 4, color: 'var(--text-secondary)' }}>时长</div>
                  <Select
                    value={minutes}
                    style={{ width: 120 }}
                    onChange={setMinutes}
                    options={(meta?.duration_options || [3, 4, 5]).map((m) => ({
                      value: m, label: `${m} 分钟`,
                    }))}
                  />
                </label>
                <div style={{ fontSize: 13 }}>
                  <div style={{ marginBottom: 4, color: 'var(--text-secondary)' }}>讲述风格</div>
                  <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
                    <Radio.Button value="duo">双主播对话</Radio.Button>
                    <Radio.Button value="single">单主讲</Radio.Button>
                  </Radio.Group>
                </div>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12, lineHeight: 1.7 }}>
                双主播更适合学生自学（对话抓注意力）；单主讲更适合课堂投屏（老师自己还要补充讲解）。
              </div>

              {needDesc ? (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 4 }}>
                    这个知识点讲什么？<span style={{ color: 'var(--error-color)' }}>（必填，会写回知识点描述）</span>
                  </div>
                  <Input.TextArea
                    rows={3}
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    placeholder="例：通过电灯、流水线、一次性餐具三个例子，理解技术对人、对社会、对自然的价值"
                    maxLength={200}
                    showCount
                  />
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
                    补这一次，AI 课件 / 播客 / 教案也会跟着变准。
                  </div>
                </div>
              ) : null}

              <div style={{ textAlign: 'right' }}>
                <Button onClick={onClose} disabled={busy} style={{ marginRight: 8 }}>取消</Button>
                <Button type="primary" loading={busy} onClick={doOutline}
                  disabled={!!meta && !meta.tts_enabled}>
                  生成大纲
                </Button>
              </div>
            </>
          )}

          {step === 'outline' && (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 10 }}
                message={`共 ${pages.length} 页 / ${totalLines} 句台词${hasAudio ? '（已有音频，可只重录改动的页）' : ''}`}
                description="点页面左侧箭头展开，可以改标题、改每一句台词、调页序。画面上的要点文字仍由 AI 决定。"
              />

              <OutlineEditor
                pages={pages}
                onChange={updatePages}
                hasAudio={hasAudio}
                regenPageIdx={regenIdx}
                onRegenPage={hasAudio ? doRegenPage : undefined}
                mode={mode2}
                nameA={nameA}
                nameB={nameB}
              />

              <div style={{ display: 'flex', alignItems: 'center', marginTop: 14, gap: 8 }}>
                <Button onClick={resetToForm} disabled={busy || regenIdx !== null}>
                  {castId ? '重新生成' : '返回'}
                </Button>
                <div style={{ flex: 1 }} />
                {dirty ? (
                  <span style={{ fontSize: 12, color: 'var(--warning-color)' }}>有未保存的改动</span>
                ) : null}
                <Button type="primary" loading={busy} onClick={doAudio}
                  disabled={!pages.length || regenIdx !== null}>
                  {hasAudio ? '保存并更新' : '合成音频并发布'}
                </Button>
              </div>
            </>
          )}

          {step === 'syncing' && (
            <div style={{ padding: '28px 8px', textAlign: 'center' }}>
              <Spin />
              <div style={{ marginTop: 14, fontSize: 13, color: 'var(--text-secondary)' }}>
                正在逐句合成语音（约 {totalLines} 句，通常 20~40 秒）…
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                同一句话重复合成不计费，所以改一句只会花一句的钱。
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
