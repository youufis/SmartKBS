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

    // 加载翻译文件的路径模式
    backend: {
      loadPath: '/locales/{{lng}}/{{ns}}.json?v=7.5.0',
    },

    // 默认命名空间
    defaultNS: 'common',

    interpolation: {
      escapeValue: false, // React 已处理 XSS
    },

    // 加载完成前不阻塞渲染
    returnObjects: false,
  })

export default i18n
