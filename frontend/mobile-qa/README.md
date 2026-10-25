# 手机端巡检（mobile-qa）

手机白名单页面在 390×844 下真实渲染一遍，量化「溢出 / 挤压 / 截断 / 破图 / 小字号 / 4xx」并逐页截图。
配套规矩见 `frontend/src/styles/mobile.css`（所有规则必须包在 `@media (max-width: 767px)` 内）

## 跑一遍

```bash
# 后端要在跑（默认 8086）。静态资源走 8086 会慢到没法测，所以先起这个反代：
node proxy.cjs                       # 127.0.0.1:5199 → frontend/dist + :8086

node scan.cjs                        # 产物：report.json + shots/*.png（都不入库）

# 直连现网/部署环境也可以：
BASE=http://localhost:8086 node scan.cjs
# 换设备宽度（320 小屏 / 平板边界）：
VW=320 node scan.cjs
```
扩展名用 `.cjs`：`frontend/package.json` 是 `"type": "module"`，`.js` 会被当成 ESM 而 `require` 不到。

默认账号取仓库根 README「演示环境」表里的测试号，可用 `TEST_STU` / `TEST_STU_PW` / `TEST_TEA` / `TEST_TEA_PW` 覆盖。
没装 playwright-core 时脚本会自己找 Codex 自带的那份，都找不到就给安装提示。

## 看什么

| 指标 | 含义 | 阈值 |
| --- | --- | --- |
| `xovf` / `hardClip` | 元素越过视口右缘 / 被 `overflow:hidden` 硬裁（横滑也救不回来） | 0 |
| `squeeze` | 宽度 <64px  yet 3 行以上 —— 标题被挤成「一字一行」 | 0 |
| `clip` | `nowrap` 文本被省略号截断（读不出内容） | 0 |
| `smallIn` | 可编辑控件字号 <16px（iOS 聚焦会整页放大，违反红线） | 0 |
| `brokenImg` | 图片 `naturalWidth=0`，多半是没带凭证的 401 | 0 |
| `badNet` / `jsErr` | 4xx·5xx 请求与页面报错 | 0 |
| `tables` | 窄屏仍在用 antd Table 的个数（明细类应走 `NarrowTable` 卡片） | 人工判断 |

有任一越线时进程返回码为 1，可以直接挂在发布前当门禁。

## 改窄屏问题的正确姿势

1. **明细类表格（流水 / 名单 / 规则表）一律 `NarrowTable`**：桌面还是 antd Table，手机自动摊成卡片。
   不要再往页面里加 `isMobile` 三元，也不要指望「表格 + 横滑」——窄屏下 antd 一旦有列宽/ellipsis
   就切 `table-layout:fixed`，全局那条 `min-width:max-content` 兜不住，实测要么撑成 6794px、要么列塌成 58px。
2. **需要登录才能取到的图片/文件 URL 一律过 `authedFileUrl()`**（`src/api/client.ts`）：
   `<img>` / `<a download>` / CSS `background:url()` 都不带 Authorization 头。
3. 所有移动样式只写在 `src/styles/mobile.css` 的 `@media (max-width: 767px)` 里，
   行内样式压不住时才用 `!important`，并在注释里写清实测数值。
4. 改完重跑 `node scan.cjs`，再人工翻 `shots/` 看一遍 —— 指标只能证明「不溢出」，读起来顺不顺还得看图。

