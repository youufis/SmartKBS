/**
 * 弹窗关闭前的「未保存内容」确认（B2）。
 *
 * 表单类弹窗已经统一 maskClosable={false}，这里再补一层：
 * 真动过内容才弹确认，没动过直接关，避免每次都问一遍把老师问麻。
 */
import { Modal } from 'antd'

export function closeWithDirtyGuard(
  dirty: boolean,
  t: (key: string) => string,
  onProceed: () => void,
): void {
  if (!dirty) {
    onProceed()
    return
  }
  Modal.confirm({
    title: t('dirtyCloseTitle'),
    content: t('dirtyCloseContent'),
    okText: t('dirtyCloseOk'),
    cancelText: t('dirtyCloseStay'),
    okButtonProps: { danger: true },
    onOk: onProceed,
  })
}
