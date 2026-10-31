/**
 * 课节资料：底部横条 + 抽屉预览。
 *
 * 只显示该知识点**已绑定**的资源（不自动拉练习），点击就地预览，不打断播放。
 * 抽屉里用 iframe：PDF 走浏览器内置阅读器，HTML 课件直接渲染。
 */
import { useState } from 'react';
import { Drawer } from 'antd';
import type { CurriculumResource } from '../../types';

interface MaterialsBarProps {
  resources: CurriculumResource[];
}

const KIND_LABEL: Record<string, string> = {
  pdf: 'PDF', doc: 'DOC', docx: 'DOC', ppt: 'PPT', pptx: 'PPT',
  html: 'HTML', video: '视频', audio: '音频', image: '图片',
  podcast: '播客', courseware: '课件', practice: '练习',
};

function kindOf(url: string, type: string): string {
  if (KIND_LABEL[type]) return KIND_LABEL[type];
  const m = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(url || '');
  const ext = (m?.[1] || '').toLowerCase();
  return KIND_LABEL[ext] || (ext ? ext.toUpperCase().slice(0, 4) : '资料');
}

export function MaterialsBar({ resources }: MaterialsBarProps) {
  const [open, setOpen] = useState<CurriculumResource | null>(null);

  if (!resources.length) return null;

  return (
    <>
      <div className="lc-materials">
        <span className="lbl">课节资料</span>
        {resources.slice(0, 6).map((r) => (
          <a
            key={r.binding_id}
            className="lc-file"
            href={r.resource_url}
            onClick={(e) => {
              e.preventDefault();
              setOpen(r);
            }}
          >
            <span className="ic">{kindOf(r.resource_url, r.resource_type)}</span>
            <span>{r.resource_name || '未命名资源'}</span>
          </a>
        ))}
      </div>

      <Drawer
        title={open?.resource_name || '课节资料'}
        placement="right"
        width="min(920px, 92vw)"
        open={!!open}
        onClose={() => setOpen(null)}
        destroyOnHidden
      >
        {open ? (
          <iframe
            src={open.resource_url}
            title={open.resource_name}
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        ) : null}
      </Drawer>
    </>
  );
}
