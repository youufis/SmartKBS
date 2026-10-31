/** 演讲者视图的独立路由页（第二屏）。只负责取参数并把窗口交给面板。 */
import React from 'react';
import { useParams } from 'react-router-dom';
import { PresenterPanel } from '../components/lessoncast/PresenterPanel';
import '../components/lessoncast/lessoncast.css';

const PresenterPage: React.FC = () => {
  const { kpId } = useParams<{ kpId: string }>();
  const id = Number(kpId);
  if (!id || Number.isNaN(id)) {
    return <div style={{ padding: 40, textAlign: 'center' }}>知识点参数不正确</div>;
  }
  return <PresenterPanel kpId={id} />;
};

export default PresenterPage;
