# 手机端巡检（mobile-qa）

白名单页面在窄屏真实渲染，量化「溢出 / 硬裁 / 挤压 / 截断 / 破图 / 小字号 / 触控目标 / 4xx / JS 报错」，逐页逐态截图。
配套规矩见 `frontend/src/styles/mobile.css`（所有规则必须包在 `@media (max-width: 767px)` 内）
与 `docs/mobile-adaptation-plan.md`。

## 跑一遍

```bash
# 后端要在跑（默认 8086）。静态资源走 8086 会慢到没法测，两个选择：
node proxy.cjs                     # 127.0.0.1:5199 → frontend/dist + :8086（测产物）
# 或者直接用开发服务器（/api 已代理到 8086）：
BASE=http://127.0.0.1:5173 node scan.cjs

node scan.cjs                      # 默认 390 / zh-CN / 全白名单 / 自动点开页签与分段控件
node scan.cjs --only=exam,explore  # 只测包含这些字样的页（改一页验一页）
node scan.cjs --states=0           # 关掉状态遍历，回到「只看默认态」的速度
node scan.cjs --vw=320 --lang=en   # 小屏 / 英文
node scan.cjs --full               # {390,320} × {zh-CN,en} 四象限全量
```

- 页面清单**直接解析 `src/constants/mobileNav.ts`**，不再手抄（v1 手抄导致白名单 28/23 项只测了 14/12 项）。
- 需要真实 id 才能进的路由（`/discussion-room`、`/discussion-monitor`、`/explore-share`、`/whiteboard-room`）会打印出来提醒人工过。
- 令牌被别的会话顶掉（后端单设备登录）时会整块重建浏览器上下文重试一次——只重写 localStorage 不够，旧文档里的在途请求会用旧令牌 401 把凭证又清掉。
- 账号取仓库根 README「演示环境」表里的测试号，可用 `TEST_STU` / `TEST_STU_PW` / `TEST_TEA` / `TEST_TEA_PW` 覆盖。
- 没装 playwright-core 时脚本会自己找 Codex 自带的那份，都找不到就给安装提示。
- 扩展名用 `.cjs`：`frontend/package.json` 是 `"type": "module"`，`.js` 会被当成 ESM 而 `require` 不到。

## 看什么

| 指标 | 含义 | 阈值 |
| --- | --- | --- |
| `xovf` | 文本越出视口，且**滑不回来**（能横滑的只有分段/页签/表格这类自带滚动容器；滑的是整页 `.ant-layout-content` 也算越线——没人知道要左右滑） | 0 |
| `hardClip` | 被某层 `overflow:hidden` 裁死（横滑也救不回来） | 0 |
| `squeeze` | 宽度 <64px  yet 3 行以上 —— 标题被挤成「一字一行」 | 0 |
| `clip` | `nowrap` 文本被硬切（**没有**省略号，读不出也没入口） | 0 |
| `clipEll` | 带省略号的截断（首页公告预览这类「点进去看全文」是设计如此） | 只报数 |
| `smallIn` | 可编辑控件字号 <16px（iOS 聚焦会整页放大，违反红线） | 0 |
| `brokenImg` | 图片 `naturalWidth=0`，多半是没带凭证的 401 | 0 |
| `touchFail` | 交互控件最小边 <28px（按不准 = 手机上不可用） | 0 |
| `touchWarn` | 最小边 <40px（iOS HIG 44pt 的建议下限） | 只报数 |
| `badNet` / `jsErr` | 4xx·5xx 请求与页面报错 | 0 |
| `tables` | 窄屏仍在用 antd Table 的个数（明细类应走 `NarrowTable` 卡片） | 人工判断 |

任一越线时进程返回码为 1，可以直接挂在发布前当门禁。

## 改窄屏问题的正确姿势

1. **明细类表格（流水 / 名单 / 规则表）一律 `NarrowTable`**：桌面还是 antd Table，手机自动摊成卡片；
   服务端分页与 `expandable` 明细都已透传（`MobileCardTable` 里渲染成卡片底部「展开/收起」）。
   不要再往页面里加 `isMobile` 三元，也不要指望「表格 + 横滑」——窄屏下 antd 一旦有列宽/ellipsis
   就切 `table-layout:fixed`，全局那条 `min-width:max-content` 兜不住，实测要么撑成 6794px、要么列塌成 58px。
2. **需要登录才能取到的图片/文件 URL 一律过 `authedFileUrl()`**（`src/api/client.ts`）：
   `<img>` / `<a download>` / CSS `background:url()` 都不带 Authorization 头。
3. **触屏没有 hover**：被截断的信息不能只挂在 `Tooltip` 上。范围类文案用 `ScopeTag`（窄屏自动改计数 +
   点按 `Popover`）或 `compactClassScope()`，别在页面里自己拼 `maxWidth + ellipsis + Tooltip`。
4. **覆盖 antd 要用 `!important`**：antd v6 是 CSS-in-JS，样式运行时注入到 `<head>`，排在 `main.tsx`
   静态引入的 `mobile.css` 之后，同特异度 antd 赢。注释里写清实测数值。
5. 所有移动样式只写在 `src/styles/mobile.css` 的 `@media (max-width: 767px)` 里，断点与 `useIsMobile` 一致。
6. 改完重跑 `node scan.cjs`，再人工翻 `shots/` 看一遍 —— 指标只能证明「不溢出」，读起来顺不顺还得看图。
   v2 截图前会摊平内部滚动容器（`Content` 是 `height:100% + overflow:auto`，v1 的 fullPage 其实只有首屏）。
