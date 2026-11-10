// 手机端巡检 v2：把「尺子」修准，再拿它验收每一批页面改动。
//
// 相比 v1 的六处升级（对应 docs/mobile-optimization-202611/00-方案建议.md 第 2 节）：
//  1. 页面清单不再手抄——直接解析 src/constants/mobileNav.ts 的白名单，杜绝「加了页面不测」
//  2. 状态遍历：逐页点开所有 Tabs / Segmented（只读筛选，不改数据），逐态测量 + 截图
//  3. 文本判据修正：元素只要「自己有非空文本节点」就参与测量（antd Button 的文案是 button
//     的直接文本节点，v1 用 children.length>0 过滤，导致右缘 459px 的「新建画布」报 0 溢出）
//  4. 截图前展开内部滚动容器：AppLayout 的 Content 是 height:100% + overflow:auto，
//     documentElement.scrollHeight 恒等于视口高，v1 的 fullPage 截图其实只有首屏
//  5. 新增触控目标指标：交互控件最小边 <28px 记 fail、<40px 记 warn（iOS HIG 44pt）
//  6. 矩阵化：--vw=390,320 --lang=zh-CN,en，报告与截图按「页×态×宽×语」分档
//
// 用法（后端要在跑，默认 8086；静态资源走 8086 太慢就先起 proxy.cjs）：
//   node proxy.cjs                                  # 127.0.0.1:5199 → frontend/dist + :8086
//   node scan.cjs                                   # 默认 390 / zh-CN / 全白名单 / 状态遍历
//   node scan.cjs --only=exam,quest                 # 只测包含这些字样的页（改一页验一页）
//   node scan.cjs --states=0                        # 关掉状态遍历，回到「只看默认态」的速度
//   node scan.cjs --vw=320 --lang=en                # 小屏 + 英文
//   node scan.cjs --full                            # {390,320} × {zh-CN,en} 四象限全量
//   BASE=http://localhost:8086 node scan.cjs        # 直连现网/部署环境
// 环境变量：BASE / TEST_STU / TEST_STU_PW / TEST_TEA / TEST_TEA_PW / CHROME 同 v1。
// 产物：report.json + shots/*.png（都不入库）。任一指标越线时退出码 1，可挂发布前当门禁。
const path = require('path'), fs = require('fs'), os = require('os');

function loadChromium() {
  const tries = ['playwright-core',
    'C:/Users/' + os.userInfo().username + '/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright-core'];
  for (const m of tries) { try { return require(m).chromium } catch (e) { /* 换下一个 */ } }
  console.error('找不到 playwright-core。装一份： npm i -D playwright-core && npx playwright install chromium');
  process.exit(2);
}
const chromium = loadChromium();

// ── CLI ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const has = (name) => argv.includes('--' + name);
const BASE = process.env.BASE || 'http://127.0.0.1:5199';
const SHOTS = path.join(__dirname, 'shots');
const VWS = (has('full') ? flag('vw', '390,320') : flag('vw', '390')).split(',').map(Number);
const LANGS = (has('full') ? flag('lang', 'zh-CN,en') : flag('lang', 'zh-CN')).split(',');
const MAX_STATES = Number(flag('states', 4));          // 每页额外点开几个态（0=只测默认态）
const ONLY = flag('only', '').split(',').map((s) => s.trim()).filter(Boolean);

// ── 白名单：从源文件解析，单一事实源 ────────────────────────────────────
// 需要真实 id 才能进的路由不在白名单里出现（/discussion-room/:groupId 等），
// 但 /discussion-room 这类前缀项直访会白屏或跳登录，列进 SKIP 并打印提醒人工过。
const SKIP = new Set(['/discussion-room', '/discussion-monitor', '/explore-share', '/whiteboard-room']);
function readWhitelist() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'constants', 'mobileNav.ts'), 'utf8');
  const pick = (varName) => {
    const m = new RegExp('const ' + varName + ' = \\[([\\s\\S]*?)\\]').exec(src);
    if (!m) throw new Error('mobileNav.ts 里找不到 ' + varName + '，白名单解析失败（改名了？同步改这里）');
    return [...m[1].matchAll(/'(\/[^']*)'/g)].map((x) => x[1]);
  };
  return { student: pick('STUDENT_ALLOWED'), staff: pick('STAFF_ALLOWED') };
}
const WL = readWhitelist();
const routesFor = (list) => list.filter((p) => !SKIP.has(p))
  .map((p) => (p === '/' ? 'dashboard' : p.replace(/^\//, '')))
  .filter((r) => !ONLY.length || ONLY.some((o) => r.includes(o)));
const ACCOUNTS = {
  student: [process.env.TEST_STU || 's11001', process.env.TEST_STU_PW || '123456', routesFor(WL.student)],
  teacher: [process.env.TEST_TEA || 'youufis', process.env.TEST_TEA_PW || 'ultraultra', routesFor(WL.staff)],
};
// 阈值：squeeze/clip/xovf/hardClip/smallIn/brokenImg/badNet/jsErr 沿用 v1 语义；
// touchFail = 最小边 <28px 的交互控件数（按不动 = 手机上不可用），touchWarn = <40px。
const THRESHOLD = { xovf: 0, hardClip: 0, squeeze: 0, clip: 0, smallIn: 0, brokenImg: 0, badNet: 0, jsErr: 0, touchFail: 0 };

// ── 页内测量 ───────────────────────────────────────────────────────────
const MEASURE = function ({ vw }) {
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  // 元素「自己」有没有非空文本节点：这决定它算不算一条可读文本。
  // v1 用 children.length===0 当叶子，antd 的 <button><span class=anticon/>新建画布</button>
  // 因为有 icon 子节点被整条跳过 —— 溢出、挤压、截断三类问题都漏报。
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  // 区分「谁在横滑」：分段控件/页签/表格自带横滑是设计如此；
  // 但如果滑的是整页内容区（.ant-layout-content），说明内容真的溢出了视口 ——
  // 用户不会知道要左右滑，「新建画布」这种主按钮就这么掉到屏外。这类算真问题。
  const inScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) {
        if (p.classList.contains('ant-layout-content')) return 'page';
        return true;
      }
      if (s.overflowX === 'hidden') return 'clipped';
      p = p.parentElement;
    }
    return false;
  };
  const shortSel = (el) => {
    let up = '', p = el, n = 0;
    while (p && p !== document.body && n < 4) {
      const pc = (p.className && typeof p.className === 'string') ? '.' + p.className.trim().split(/\s+/)[0] : '';
      up = (p.tagName.toLowerCase() + pc) + (up ? ' > ' + up : '');
      p = p.parentElement; n++;
    }
    return up;
  };
  const out = {
    stuckSplash: /^加载中/.test((document.body.innerText || '').trim()),
    docScrollW: document.documentElement.scrollWidth,
    contentScrollW: (() => { const c = document.querySelector('.ant-layout-content'); return c ? c.scrollWidth : 0 })(),
    contentClientW: (() => { const c = document.querySelector('.ant-layout-content'); return c ? c.clientWidth : window.innerWidth })(),
    pageH: document.documentElement.scrollHeight,
    textLen: (document.body.innerText || '').length,
    overflowX: [], squeeze: [], clipped: [], clippedEllipsis: [], smallInputs: [], brokenImgs: [], tables: [], touchFail: [], touchWarn: [],
  };
  const texts = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (!vis(el)) return;
    const t = ownText(el) || (el.children.length === 0 ? (el.textContent || '').trim() : '');
    if (t) texts.push({ el, t });
  });
  for (const { el, t } of texts) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 2 || r.left < -2) {
      const sc = inScroller(el);
      out.overflowX.push({ t: t.slice(0, 32), right: Math.round(r.right), sel: shortSel(el), scrollable: sc === true, pageScroll: sc === 'page', hardClip: sc === 'clipped' });
    }
    const s = getComputedStyle(el); const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
    if (Math.round(r.height / lh) >= 3 && r.width < 64 && t.length <= 10) out.squeeze.push({ t: t.slice(0, 10), w: Math.round(r.width), sel: shortSel(el) });
    if (s.whiteSpace === 'nowrap' && el.scrollWidth > el.clientWidth + 2 && t.length > 3) {
      const rec = { t: t.slice(0, 32), cw: el.clientWidth, sw: el.scrollWidth, sel: shortSel(el) };
      // 有省略号 = 用户看得出「还有下文」，且这些行本就设计成点进详情（首页公告预览）；
      // 没有省略号 = 内容被硬切一刀，读不出也点不出。只有后者算越线。
      (s.textOverflow === 'ellipsis' ? out.clippedEllipsis : out.clipped).push(rec);
    }
  }
  document.querySelectorAll('input, textarea, select').forEach((el) => {
    if (!vis(el) || ['checkbox', 'radio', 'hidden', 'button', 'submit', 'file'].includes(el.type)) return;
    if (parseFloat(getComputedStyle(el).fontSize) < 16) out.smallInputs.push({ ph: (el.placeholder || '').slice(0, 14), fs: getComputedStyle(el).fontSize });
  });
  document.querySelectorAll('img').forEach((el) => { if (el.complete && el.naturalWidth === 0 && el.currentSrc) out.brokenImgs.push(el.currentSrc.replace(location.origin, '').slice(0, 60)); });
  document.querySelectorAll('.ant-table').forEach((el) => {
    if (!vis(el)) return;
    const wrap = el.querySelector('.ant-table-content, .ant-table-body');
    let tall = 0, maxH = 0;
    el.querySelectorAll('tbody tr:first-child td').forEach((td) => { const h = td.getBoundingClientRect().height; maxH = Math.max(maxH, h); if (h > 56) tall++; });
    out.tables.push({ cols: el.querySelectorAll('thead th').length, overflowX: wrap ? wrap.scrollWidth - wrap.clientWidth : 0, tallCells: tall, firstRowMaxCellH: Math.round(maxH), head: Array.from(el.querySelectorAll('thead th')).slice(0, 10).map((th) => (th.textContent || '').trim().slice(0, 6)).join('|') });
  });
  // 触控目标：只算真能点的控件；正文里的行内链接（markdown 渲染）不算。
  // 勾选框量 .ant-checkbox-wrapper（真正接受点击的整块），不要量 .ant-checkbox-input
  // ——那个原生 input 只有 16×16 且被 -webkit-appearance:none 藏在方块后面，是假阳性。
  const TOUCH = 'button, [role="button"], .ant-segmented-item, .ant-tabs-tab, .ant-pagination-item, .ant-pagination-prev, .ant-pagination-next, .ant-radio-button-wrapper, .ant-switch, .ant-checkbox-wrapper, .ant-tag-checkable';
  document.querySelectorAll(TOUCH).forEach((el) => {
    if (!vis(el)) return;
    if (el.closest('.markdown-content') || el.closest('.ant-tabs-nav-operations')) return;
    // 只算最外层可点元素：按钮内部的 <span class=anticon> 不是独立目标，
    // 否则「把按钮做大」永远消不掉内层图标的 13×13 记录（实测 .ant-typography-edit）。
    const host = el.parentElement && el.parentElement.closest(TOUCH);
    if (host && host !== el) return;
    const r = el.getBoundingClientRect();
    const min = Math.min(r.width, r.height);
    const rec = { t: (el.textContent || '').trim().slice(0, 12), w: Math.round(r.width), h: Math.round(r.height), sel: shortSel(el) };
    // 开关豁免：antd 小号 Switch 的轨道就是 16px 高，用 CSS 硬拉会把滑块几何搞乱，
    // 正解是页面里别用 size="small"（已列进后续清单）。这里只记 warn，不拦门禁。
    if (el.classList.contains('ant-switch')) { if (min < 40) out.touchWarn.push(rec); return; }
    if (min < 28) out.touchFail.push(rec); else if (min < 40) out.touchWarn.push(rec);
  });
  const uniq = (arr, k) => { const s = new Set(); return arr.filter((x) => { const key = k(x); if (s.has(key)) return false; s.add(key); return true }) };
  out.overflowX = uniq(out.overflowX, (x) => x.t + x.right).slice(0, 12);
  out.squeeze = uniq(out.squeeze, (x) => x.t + x.w).slice(0, 10);
  out.clipped = uniq(out.clipped, (x) => x.t + x.cw).slice(0, 10);
  out.clippedEllipsis = uniq(out.clippedEllipsis, (x) => x.t + x.cw).slice(0, 6);
  out.touchFail = uniq(out.touchFail, (x) => x.t + x.h).slice(0, 10);
  out.touchWarn = uniq(out.touchWarn, (x) => x.t + x.h).slice(0, 10);
  return out;
};

// 截图前把内部滚动容器摊平：否则 fullPage 只有首屏（Content 是 height:100% + overflow:auto）。
// 只在截图这一刻改样式，测量已经做完了，不影响指标。
const EXPAND = () => {
  let n = 0;
  document.querySelectorAll('*').forEach((el) => {
    const s = getComputedStyle(el);
    if (/(auto|scroll|hidden)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2) {
      el.style.setProperty('overflow-y', 'visible', 'important');
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      n++;
    }
  });
  document.querySelectorAll('.ant-layout, .ant-layout-content').forEach((el) => {
    el.style.setProperty('height', 'auto', 'important');
    el.style.setProperty('min-height', '0', 'important');
  });
  return n;
};

function findChromium() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => /^chromium/.test(d)).sort().reverse() } catch (e) { return undefined }
  for (const d of dirs) {
    for (const cand of [path.join(root, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
      path.join(root, d, 'chrome-win64', 'chrome.exe'), path.join(root, d, 'chrome-linux', 'chrome')]) {
      if (fs.existsSync(cand)) return cand;
    }
  }
  return undefined;
}
async function login(user, pass) {
  const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username_or_name: user, password: pass }) });
  const j = await res.json();
  if (!j.token) throw new Error('登录失败 ' + user + '：' + JSON.stringify(j).slice(0, 160));
  return j;
}
async function settle(page) {
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').trim();
    return t.length > 24 && !/^加载中/.test(t) && !document.querySelector('.ant-spin-spinning') && !document.querySelector('.ant-skeleton');
  }, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1200);
}
// 页签 / 分段控件的「非默认分支」：v1 从没点开过，最严重的两个裸表就藏在这里。
async function stateControls(page) {
  return page.evaluate(() => {
    const list = [];
    document.querySelectorAll('.ant-tabs-nav-list > .ant-tabs-tab').forEach((el, i) => {
      if (!el.className.includes('ant-tabs-tab-active')) list.push({ kind: 'tab', i, label: (el.textContent || '').trim().slice(0, 12) });
    });
    document.querySelectorAll('.ant-segmented-item').forEach((el, i) => {
      if (!el.className.includes('ant-segmented-item-selected')) list.push({ kind: 'seg', i, label: (el.textContent || '').trim().slice(0, 12) });
    });
    return list;
  });
}
async function clickState(page, c) {
  const sel = c.kind === 'tab' ? '.ant-tabs-nav-list > .ant-tabs-tab' : '.ant-segmented .ant-segmented-item';
  const el = (await page.$$(sel))[c.i];
  if (!el) return false;
  await el.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1600);
  return true;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  const report = {};
  let fail = 0, pages = 0;
  for (const vw of VWS) for (const lang of LANGS) {
    const tagSuffix = (VWS.length > 1 || LANGS.length > 1) ? '@' + vw + (lang !== 'zh-CN' ? '-' + lang : '') : '';
    for (const [role, [user, pass, routes]] of Object.entries(ACCOUNTS)) {
      // 一套「登录态 + 页面 + 监听」。抽成函数是为了能在令牌失效时整块重建：
      // 只重写 localStorage 不够 —— 旧文档里还在飞的请求会用旧令牌 401，
      // 前端的 401 拦截器又把凭证清掉，于是后面每一页都跳登录（实测整轮报废）。
      const makeSession = async () => {
        const sess = await login(user, pass);
        const ctx = await browser.newContext({ viewport: { width: vw, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        await ctx.addInitScript(([t, usr, lng]) => {
          localStorage.setItem('smartkb_token', t);
          localStorage.setItem('smartkb_user', JSON.stringify(usr));
          localStorage.setItem('smartkb_lang', lng);
        }, [sess.token, sess.user, lang]);
        const page = await ctx.newPage();
        const errs = [], net = [];
        page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 110)));
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const t = m.text();
        // 噪音白名单（都不是页面布局问题）：devtools/deprecated 是 React 与 antd 的告警；
        // Failed to load resource 由 badNet 按状态码记过；WebSocket connection 在本地代理下必然失败。
          if (/devtools|deprecated|Failed to load resource|WebSocket connection/i.test(t)) return;
          errs.push('c:' + t.slice(0, 110));
        });
        page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) net.push(r.status() + ' ' + r.url().replace(BASE, '').slice(0, 80)); });
        return { ctx, page, errs, net };
      };
      let S = await makeSession();
      let { page, errs, net } = S;
      for (const rt of routes) {
        const key = role + '--' + rt + tagSuffix;
        pages++;
        try {
          await page.goto(BASE + '/' + rt, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await settle(page);
          if (/\/login$/.test(page.url())) {
            // 后端是单设备登录语义：另一次巡检或手工登录会把令牌顶掉（token_stale）；
            // 长跑中途过期也是正常的。这不是页面问题，换一套干净会话重试一次，
            // 仍进登录页才算越线。
            await S.ctx.close();
            S = await makeSession(); page = S.page; errs = S.errs; net = S.net;
            await page.goto(BASE + '/' + rt, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await settle(page);
          }
          if (/\/login$/.test(page.url())) { report[key] = { redirectedToLogin: true }; console.log(key.padEnd(34) + ' -> 跳登录（账号或白名单问题）'); fail++; continue; }
          // 每个态都「重新进页 → 点到位 → 量 → 摊平 → 截图」。
          // 为什么不复用同一次打开：摊平内部滚动容器会改 overflow/height，留在页面上
          // 会污染下一个态的溢出判定；而一路点下去再统一截图，每个态的截图其实都是
          // 最后一个态的画面（v2 初版踩过，截图全对不上号）。
          const controls = MAX_STATES > 0 ? (await stateControls(page)).slice(0, MAX_STATES) : [];
          const states = [];
          for (let si = 0; si <= controls.length; si++) {
            if (si > 0) {
              await page.goto(BASE + '/' + rt, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await settle(page);
              if (!(await clickState(page, controls[si - 1]))) continue;
            }
            const name = si === 0 ? 'default' : controls[si - 1].kind + ':' + controls[si - 1].label;
            const m = await page.evaluate(MEASURE, { vw });
            m.jsErrors = [...new Set(errs)].slice(0, 5); m.badNet = [...new Set(net)].slice(0, 5);
            errs.length = 0; net.length = 0;
            await page.evaluate(EXPAND);
            await page.screenshot({ path: path.join(SHOTS, key + (si === 0 ? '' : '~' + name.replace(/[^\w一-龥]+/g, '-')) + '.png'), fullPage: true }).catch(() => {});
            states.push({ name, m });
          }
          report[key] = { states: states.map((s) => ({ state: s.name, ...s.m })) };
          // xovf 只算「越出视口且不在可横滑容器里」的：分段/页签窄屏本就设计成左右滑，容器能滚不算问题；
          // 真正读不出内容的是 hardClip（被 overflow:hidden 裁死）。
          const n = {
            xovf: states.reduce((a, s) => a + s.m.overflowX.filter((o) => !o.scrollable || o.pageScroll).length, 0),
            hardClip: states.reduce((a, s) => a + s.m.overflowX.filter((o) => o.hardClip).length, 0),
            squeeze: states.reduce((a, s) => a + s.m.squeeze.length, 0),
            clip: states.reduce((a, s) => a + s.m.clipped.length, 0),
            clipEll: states.reduce((a, s) => a + (s.m.clippedEllipsis || []).length, 0),
            smallIn: states.reduce((a, s) => a + s.m.smallInputs.length, 0),
            brokenImg: states.reduce((a, s) => a + s.m.brokenImgs.length, 0),
            badNet: states.reduce((a, s) => a + s.m.badNet.length, 0),
            jsErr: states.reduce((a, s) => a + s.m.jsErrors.length, 0),
            touchFail: states.reduce((a, s) => a + s.m.touchFail.length, 0),
          };
          const warn = states.reduce((a, s) => a + s.m.touchWarn.length, 0);
          // clipEll（带省略号的截断）只报数不设阈：它是「设计如此」的提示，不是故障
          const over = Object.keys(THRESHOLD).filter((k) => n[k] > THRESHOLD[k]);
          if (over.length) fail++;
          console.log(key.padEnd(34) + ' states=' + states.length + ' ' + Object.entries(n).map(([k, v]) => k + '=' + v).join(' ') + ' touchWarn=' + warn + ' tables=' + states.reduce((a, s) => a + s.m.tables.length, 0) + ' docW=' + states[0].m.docScrollW + (over.length ? '   <== ' + over.join(',') : ''));
        } catch (e) { report[key] = { error: String(e.message).slice(0, 160) }; fail++; console.log(key.padEnd(34) + ' ERROR ' + String(e.message).slice(0, 90)); }
      }
      await S.ctx.close();
    }
  }
  fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 1));
  console.log('' + '页面数=' + pages + '  越线页面数=' + fail + '  阈值=' + JSON.stringify(THRESHOLD));
  console.log('跳过（需真实 id，请人工过一遍）：' + [...SKIP].join(' '));
  console.log('报告：report.json 截图：shots/');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();



