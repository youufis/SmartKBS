/**
 * tldraw SDK 授权位（全项目唯一来源）
 *
 * tldraw 不是开源库：源码可见，但按 tldraw license 商业授权。条款里有三条必须守住的线，
 * 改动本文件（或白板相关组件）时请一并遵守，别再用 CSS 走捷径：
 *   1. 生产环境必须带有效 license key（开发环境不需要 key）；
 *   2. 不得隐藏、遮挡或以任何方式干扰水印与授权校验 —— 水印本身就是许可的对价；
 *      未授权/已过期的 key 在 https 生产环境下，SDK 会在 5 秒后把画布整体替换成空白
 *      （LicenseProvider 的 LicenseGate），遮水印救不了这个，只有合法 key 才行；
 *   3. 再分发安装包时必须原样附带许可全文，见 frontend/public/THIRD-PARTY-NOTICES/。
 *
 * key 从构建期环境变量注入，不进源码仓库：
 *   frontend/.env.local     本机开发 + 出包（被 frontend/.gitignore 的 *.local 忽略）
 *   frontend/.env.example   模板与说明（入库）
 * 出包前先跑：.venv\Scripts\python.exe scripts\check_tldraw_license.py --strict
 *
 * 备注：tldraw 自身也会读 import.meta.env.VITE_TLDRAW_LICENSE_KEY，这里显式取一次，
 * 是为了有单一入口、能在缺 key 时给出可读告警，而不是散落在三个组件里各写各的。
 */

const rawKey = (import.meta.env.VITE_TLDRAW_LICENSE_KEY as string | undefined) ?? ''

/** 传给 <Tldraw licenseKey>；空串归一成 undefined（= 未授权，由 SDK 自行提示） */
export const TL_LICENSE_KEY: string | undefined = rawKey.trim() || undefined

if (!TL_LICENSE_KEY && import.meta.env.DEV) {
  console.warn(
    '[tldraw] 未配置 VITE_TLDRAW_LICENSE_KEY（写在 frontend/.env.local）。' +
      '本地开发可以继续用，但出包/上线前必须填：https 生产环境下没有合法 key，' +
      '白板画布会在 5 秒后被 SDK 隐藏。',
  )
}