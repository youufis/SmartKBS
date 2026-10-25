// 手机端巡检：逐页在窄屏真实渲染，量化「溢出 / 挤压 / 截断 / 破图 / 小字号」并截图。
//
// 用法：
//   1) 起本地静态+API 反代（可选，直连 8086 太慢时用它）：  node proxy.js
//   2) 跑巡检：                                             node scan.js
//   环境变量：BASE（默认 http://127.0.0.1:5199）、VW/VH（默认 390/844）
//   产物：report.json（逐页指标）+ shots/*.png（截图），两者都不入库（见 .gitignore）
//
// 退出码：有任何一项越过阈值时返回 1，可直接挂在 release 流程上做门禁。
const path = require('path');
// playwright-core：项目里装了就用项目里的；没装则退回 Codex 随 @playwright/mcp 带的那份。
// 两处都没有时给出可执行的提示，而不是抛一个看不懂的 MODULE_NOT_FOUND。
function loadChromium() {
  const tries = ['playwright-core',
    'C:/Users/' + require('os').userInfo().username + '/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright-core'];
  for (const m of tries) { try { return require(m).chromium } catch (e) { /* 换下一个 */ } }
  console.error('找不到 playwright-core。装一份： npm i -D playwright-core && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = { chromium: loadChromium() };

const BASE = process.env.BASE || 'http://127.0.0.1:5199';
const VW = Number(process.env.VW || 390);
const VH = Number(process.env.VH || 844);
const SHOTS = path.join(__dirname, 'shots');

// 与 src/constants/mobileNav.ts 的白名单保持一致：只测手机上真能打开的页面。
// 需要登录态或会改数据的页面（/chat 会烧 token、/exam-take、抢答 play、白板）不在这里，
// 那些要手工过一遍。
const STUDENT = ['dashboard', 'portrait', 'score', 'tasks', 'task-todo', 'portfolio', 'showcase',
  'exam', 'practice', 'interaction', 'quick-quiz', 'student-questions', 'wrong-book', 'discussion'];
const TEACHER = ['dashboard', 'score', 'portrait', 'tasks', 'summary-export', 'quest-records',
  'class-summary', 'analytics', 'student-questions', 'portfolio', 'showcase', 'downloads'];
// 测试账号见 README.md「演示环境」表；换成自己的账号用 TEST_STU / TEST_TEA 覆盖
const ACCOUNTS = {
  student: [process.env.TEST_STU || 's11001', process.env.TEST_STU_PW || '123456', STUDENT],
  teacher: [process.env.TEST_TEA || 'youufis', process.env.TEST_TEA_PW || 'ultraultra', TEACHER],
};
// 阈值：>0 即视为回归。squeeze/clip 是「读不出内容」，xovf 是溢出视口，
// brokenImg 是没带凭证的图片，smallIn 违反 iOS 16px 红线，net 是 4xx/5xx。
const THRESHOLD = { xovf: 0, hardClip: 0, squeeze: 0, clip: 0, smallIn: 0, brokenImg: 0, badNet: 0, jsErr: 0 };

const MEASURE = function (vw) {
  const vis = (el) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const inScroller = (el) => { let p = el.parentElement; while (p && p !== document.body) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; if (s.overflowX === 'hidden') return 'clipped'; p = p.parentElement; } return false; };
  const shortSel = (el) => { let up = '', p = el, n = 0; while (p && p !== document.body && n < 4) { const pc = (p.className && typeof p.className === 'string') ? '.' + p.className.trim().split(/\s+/)[0] : ''; up = (p.tagName.toLowerCase() + pc) + (up ? ' > ' + up : ''); p = p.parentElement; n++; } return up; };
  const out = { stuckSplash: /^加载中/.test((document.body.innerText || '').trim()), docScrollW: document.documentElement.scrollWidth, pageH: document.documentElement.scrollHeight, textLen: (document.body.innerText || '').length, overflowX: [], squeeze: [], clipped: [], smallInputs: [], brokenImgs: [], tables: [] };
  const leaves = [];
  document.querySelectorAll('body *').forEach((el) => { if (!vis(el) || el.children.length > 0) return; const t = (el.textContent || '').trim(); if (t) leaves.push({ el, t }); });
  for (const { el, t } of leaves) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 2 || r.left < -2) { const sc = inScroller(el); out.overflowX.push({ t: t.slice(0, 32), right: Math.round(r.right), sel: shortSel(el), scrollable: sc === true, hardClip: sc === 'clipped' }); }
    const s = getComputedStyle(el); const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
    if (Math.round(r.height / lh) >= 3 && r.width < 64 && t.length <= 10) out.squeeze.push({ t: t.slice(0, 10), w: Math.round(r.width), sel: shortSel(el) });
    if (s.whiteSpace === 'nowrap' && el.scrollWidth > el.clientWidth + 2 && t.length > 3) out.clipped.push({ t: t.slice(0, 32), cw: el.clientWidth, sw: el.scrollWidth, sel: shortSel(el) });
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
  out.overflowX = out.overflowX.slice(0, 12); out.squeeze = out.squeeze.slice(0, 10); out.clipped = out.clipped.slice(0, 10);
  return out;
};

// 浏览器可执行文件：优先环境变量，其次在 ms-playwright 缓存里挑一个真实存在的目录。
// 为什么不让 playwright 自己找：它按自己的版本号找（例如 chromium_headless_shell-1237），
// 机器上装的是别的 revision 就会直接报「Executable doesn't exist」。
function findChromium() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = require('path').join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  let dirs = [];
  try { dirs = require('fs').readdirSync(root).filter((d) => /^chromium/.test(d)).sort().reverse() } catch (e) { return undefined }
  for (const d of dirs) {
    for (const cand of [require('path').join(root, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
      require('path').join(root, d, 'chrome-win64', 'chrome.exe'),
      require('path').join(root, d, 'chrome-linux', 'chrome')]) {
      if (cand && require("fs").existsSync(cand)) return cand;
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
// 页面真正渲染完的判据：不是首屏 splash、没有 spin/skeleton、正文够长
async function settle(page) {
  await page.waitForFunction(() => {
    const t = (document.body.innerText || '').trim();
    return t.length > 24 && !/^加载中/.test(t) && !document.querySelector('.ant-spin-spinning') && !document.querySelector('.ant-skeleton');
  }, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1400);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  const report = {};
  let fail = 0;
  for (const [role, [user, pass, routes]] of Object.entries(ACCOUNTS)) {
    const sess = await login(user, pass);
    const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await ctx.addInitScript(([t, usr]) => {
      localStorage.setItem('smartkb_token', t);
      localStorage.setItem('smartkb_user', JSON.stringify(usr));
    }, [sess.token, sess.user]);
    const page = await ctx.newPage();
    const errs = [], net = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 110)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // 噪音白名单（都不是页面布局问题，放行才不会把门禁搞成天天红）：
      //  · devtools / deprecated：React 与 antd 的告警
      //  · Failed to load resource：同一件事 badNet 已经按状态码记过了，不重复计
      //  · WebSocket connection：proxy.cjs 只透传 HTTP，WS 升级在本地代理下必然失败
      if (/devtools|deprecated|Failed to load resource|WebSocket connection/i.test(t)) return;
      errs.push('c:' + t.slice(0, 110));
    });
    page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) net.push(r.status() + ' ' + r.url().replace(BASE, '').slice(0, 80)); });
    for (const rt of routes) {
      const key = role + '--' + rt;
      try {
        await page.goto(BASE + '/' + rt, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await settle(page);
        if (/\/login$/.test(page.url())) { report[key] = { redirectedToLogin: true }; console.log(key.padEnd(28) + ' -> 跳登录（账号或白名单问题）'); fail++; continue; }
        const m = await page.evaluate(MEASURE, VW);
        m.jsErrors = [...new Set(errs)].slice(0, 5); m.badNet = [...new Set(net)].slice(0, 5);
        errs.length = 0; net.length = 0;
        await page.screenshot({ path: path.join(SHOTS, key + '.png'), fullPage: true });
        report[key] = m;
        // xovf 只算「越出视口且不在可横滑容器里」的：分段控件这类窄屏本来就设计成左右滑，
        //  容器自己能滚就不算问题；真正读不出内容的是 hardClip（被 overflow:hidden 裁死）。
        const n = { xovf: m.overflowX.filter((o) => !o.scrollable).length, hardClip: m.overflowX.filter((o) => o.hardClip).length, squeeze: m.squeeze.length, clip: m.clipped.length, smallIn: m.smallInputs.length, brokenImg: m.brokenImgs.length, badNet: m.badNet.length, jsErr: m.jsErrors.length };
        const over = Object.keys(THRESHOLD).filter((k) => n[k] > THRESHOLD[k]);
        if (over.length) fail++;
        console.log(key.padEnd(28) + Object.entries(n).map(([k, v]) => k + '=' + v).join(' ') + ' tables=' + m.tables.length + ' docW=' + m.docScrollW + (over.length ? '   <== ' + over.join(',') : ''));
      } catch (e) { report[key] = { error: String(e.message).slice(0, 160) }; fail++; console.log(key.padEnd(28) + ' ERROR ' + String(e.message).slice(0, 90)); }
    }
    await ctx.close();
  }
  require('fs').writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 1));
  console.log('' + '页面数=' + Object.keys(report).length + '  越线页面数=' + fail + '  阈值=' + JSON.stringify(THRESHOLD));
  console.log('报告：report.json 截图：shots/');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
