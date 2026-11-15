/**
 * i18next 初始化配置
 * - 支持浏览器语言自动检测
 * - 异步加载翻译 JSON 文件
 * - 默认语言为中文 (zh-CN)
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import Backend from 'i18next-http-backend'

// 翻译缓存破坏参数：版本号 + 构建号。
// 只有版本号是不够的 —— 它在发版之间是不变的，而文案每次构建都可能新增键，
// 那样新键会一直命中浏览器里的旧 system.json，界面上直接显示成键名。
// 构建号由 vite.config.ts 的 define 注入，每次构建变化，正好覆盖"文案改了"这件事。
import pkg from '../package.json'
declare const __APP_BUILD__: string
const _cacheBust = `v=${pkg.version}+b=${__APP_BUILD__}`

i18n
  .use(Backend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'zh-CN',
    debug: false,

    // 语言检测选项
    detection: {
      // 优先级：localStorage > 默认中文
      order: ['localStorage'],
      // localStorage 存储键名
      lookupLocalStorage: 'smartkb_lang',
      caches: ['localStorage'],
    },

    // 加载翻译文件的路径模式（带版本号做缓存破坏）
    backend: {
      loadPath: `/locales/{{lng}}/{{ns}}.json?${_cacheBust}`,
    },

    // 默认命名空间
    defaultNS: 'common',

    interpolation: {
      escapeValue: false, // React 已处理 XSS
    },

    // 加载完成前不阻塞渲染
    returnObjects: false,
  })

// 检测完就把 <html lang> 对齐（index.html 里写死 zh-CN，英文用户刷新后仍是 zh-CN，
// 读屏、字体回退、浏览器翻译提示都会认错语言）
if (typeof document !== 'undefined') document.documentElement.lang = i18n.language || 'zh-CN'
i18n.on('languageChanged', (lng) => { if (typeof document !== 'undefined') document.documentElement.lang = lng })

export default i18n
