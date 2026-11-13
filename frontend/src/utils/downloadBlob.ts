/** 统一 blob 下载：挂载锚点 + 延迟 revoke。
 * Electron 异步解析 blob URL，click 后立即 revoke 会回退成 blob UUID 文件名（无扩展名）；
 * 浏览器同步解析虽不受影响，统一走安全写法。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  window.setTimeout(() => {
    URL.revokeObjectURL(href)
    a.remove()
  }, 10_000)
}

export default downloadBlob
