"""
AI 生成 HTML 资源 Prompt 模板
资源中心 - 4 种 HTML 资源类型：
- animation: 动画讲解（杂志风格知识讲解页）
- quiz: 互动答题（星际风格课堂互动答题）
- practice: 章节练习（练习题 + 统计图表）
- custom: 自定义 HTML（按用户需求生成）
"""
from typing import Any

ANIMATION_HTML_PROMPT = """你是一位专业的教育 HTML 内容设计师。请根据以下知识点，生成一个**杂志风格的动画讲解 HTML 页面**。

## ◈ 知识点
{topic}

## ◈ 学科 & 年级
{subject_info}

## ◈ 参考知识
{rag_context}

## ◈ 参考 HTML 结构（请严格按照此模式生成）

### 整体风格（参考：杂志风/编辑风）
- 使用 serif 标题字体（'Times New Roman','Georgia','Noto Serif SC',serif）
- 配色：黑白为主 + 单色强调色（蓝色 #2563eb / 绿色 #16a34a / 紫色 #7c3aed / 橙色 #ea580c）
- 背景色 #fafafa，卡片背景 #ffffff
- 正文字体 'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif，字号 18px
- 行高 1.8，干净简洁
- 页面顶部固定 3px 阅读进度条

### CSS 变量定义（必须使用 :root + CSS 变量）
```css
:root {
  --bg:#fafafa; --card-bg:#ffffff; --text:#111111; --text-dim:#666666;
  --black:#000000; --blue:#2563eb; --green:#16a34a; --purple:#7c3aed; --orange:#ea580c;
  --red:#dc2626; --teal:#0d9488; --border:#e5e7eb;
  --radius:0px;
  --font-title:'Times New Roman','Georgia','Noto Serif SC',serif;
}
```

### 页面结构（严格按此顺序）

1. **进度条（Progress Bar）**：
```html
<div class="progress-wrap"><div class="progress-bar"></div></div>
```
```css
.progress-wrap { position:fixed; top:0; left:0; width:100%; height:3px; z-index:999; background:#eee; }
.progress-bar { height:100%; width:0; background:var(--black); animation:progGrow both; animation-timeline:scroll(root); animation-range:0% 100%; }
@keyframes progGrow { from { width:0 } to { width:100% } }
```

2. **Hero 大标题区**：全屏（min-height:100vh），flex 居中，包含：
   - `.hero-masthead`：顶部杂志卷标（小字，letter-spacing，position absolute）
   - `.hero-badge`：黑色标签徽章（FEATURE 字样）
   - `h1`：大标题（含 .line1 副标题行 + .line2 主标题）
   - `.hero-sub`：描述副文本
   - `.hero-scroll`：底部滚动提示"▼ 阅读全文"
   - 所有元素有渐入动画（badgeIn 0.8s / titleIn 1s / fadeUp 0.8s）

3. **学习目标区**（.section > .section-inner）：
   - `.section-header`：含 ".section-issue"（VOL. X — 标题）和 ".section-title"（h2 标题）
   - 使用 `.g2`（display:grid; grid-template-columns:1fr 1fr; gap:2rem）双栏卡片展示 2-3 个学习目标
   - 每个目标卡片使用 `.article` 样式

4. **正文分节**（每节一个 .section > .section-inner）：
   - 每个知识点/性质用 `.property-card` 展示
   - 左侧 3px 彩色边框（border-left:3px solid var(--color)）
   - 包含图标区 `.prop-icon`、标题 `.prop-header > h4`、编号 `.prop-num`
   - 正文 p + 案例引用 `.pull-quote`（左侧 4px 黑色边框，斜体）
   - 脚注框 `.footnote`：带 `.fn-label`（CASE 标签）和正文
   - 可选用双栏布局 `.g2`，3 个卡片中前两个各占一栏，第三个可 grid-column:1/-1 跨栏
   - 底部可有 `.highlight-bar`：黑底白字全宽高亮条

5. **总结区**（.summary）：min-height:40vh，flex 居中，包含 h2 + .byline

### 动画要求
- 所有入口动画使用 CSS @keyframes（badgeIn, titleIn, fadeUp, headIn, artIn）
- 滚动触发动画使用 `animation-timeline:view()`（渐进增强，@supports 检测）
- 动画范围 `animation-range:entry 0% entry 50%` 等
- 响应式：@media (max-width:768px) 时 .g2 变单栏，字号缩小

## ◈ 可选视觉风格（共 17 种动画讲解主题，选择其中一种使用）
**重要**：根据知识点内容选择最合适的主题。每个主题有独立的 CSS 变量前缀，在生成时统一按所选主题命名。

### 1. 📰 杂志编辑（Magazine / Editorial）
```css
:root{--bg:#fafafa;--card-bg:#ffffff;--text:#111111;--text-dim:#666666;--black:#000000;--blue:#2563eb;--green:#16a34a;--purple:#7c3aed;--orange:#ea580c;--border:#e5e7eb;--radius:0px;--font-title:'Times New Roman','Georgia','Noto Serif SC',serif}
```
特点：黑白灰主色、serif 标题、干净简洁、杂志排版、滚动驱动动画

### 2. 💿 赛博数据流（Cyber Data-Stream）
```css
:root{--bg:#0a0a1a;--bg2:#12122a;--text:#e0e0ff;--text-dim:#7a7aaa;--pink:#ff2d78;--blue:#00b8ff;--cyan:#00f5d4;--purple:#a855f7;--orange:#fb923c;--card-bg:rgba(18,18,42,0.6);--card-border:rgba(0,184,255,0.08);--radius:12px;--font-mono:'Courier New','Consolas','JetBrains Mono',monospace}
```
特点：深色背景+40px 粒子网格、霓虹粉/蓝/青色、等宽字体点缀、科技感发光

### 3. 🏛️ 文明展馆（Museum / Timeline）
```css
:root{--bg:#f5eddf;--bg-dark:#e8dcc9;--text:#2c2416;--text-dim:#7a6b54;--gold:#c9a84c;--gold-light:#e8d48b;--deepred:#7a2020;--brown:#5c3d2e;--teal:#2a7a6e;--card-bg:rgba(255,252,245,0.85);--radius:4px;--shadow:0 4px 24px rgba(0,0,0,0.06)}
```
特点：羊皮纸暖底色、金色+深红点缀、仿古风格、serif 字体、文明长廊感

### 4. ☯️ 太极对话（Yin-Yang Dialogue）
```css
:root{--bg:#1a1412;--bg-card:rgba(26,20,18,0.6);--text:#f0eae6;--text-dim:#998e88;--amber:#e8833a;--gold:#e8b84a;--teal:#3ab8b8;--mint:#4ae0c0;--warm:#d4a373;--radius:10px;--card-border:rgba(232,131,58,0.04)}
```
特点：深褐底色、琥珀+青绿双色对比、温暖光晕、对话/思辨感

### 5. 🏛️ 古典殿堂（Classical Monument）
```css
:root{--bg:#f5f0eb;--bg2:#ede6dc;--text:#2c241e;--text-dim:#7a6e64;--marble:#faf6f0;--stone:#d4c9bc;--gold:#b8860b;--gold-light:#d4a843;--slate:#5a4e44;--accent:#8b4513;--radius:8px;--shadow:0 2px 20px rgba(44,36,30,0.04)}
```
特点：暖灰大理石底色、金色+石板色、Noto Serif SC serif 字体、45°斜纹纹理、庄严感

### 6. 🧭 冒险旅程（Adventure Story）
```css
:root{--bg:#faf8f5;--text:#1e293b;--text-light:#64748b;--c1:#2d6a9f;--c2:#f59e0b;--c3:#10b981;--c4:#8b5cf6;--c5:#ef4444;--c6:#0d9488;--card-bg:rgba(255,255,255,0.85);--shadow:0 8px 32px rgba(0,0,0,0.08);--radius:20px}
```
特点：暖白底色、多彩色强调（蓝/黄/绿/紫/红/青）、大圆角 20px、柔和阴影、故事感

### 7. 🔬 实验室（Dark Lab）
```css
:root{--bg:#0a0e27;--bg2:#111638;--text:#e0e7ff;--text-dim:#8892b0;--cyan:#00f0ff;--green:#00ff88;--red:#ff3355;--amber:#ffb347;--purple:#a78bfa;--card-bg:rgba(17,22,56,0.7);--card-border:rgba(0,240,255,0.15);--radius:12px;--font-mono:'Courier New','Consolas','JetBrains Mono',monospace}
```
特点：深蓝实验室底色、网格叠加、霓虹青/绿/紫色、等宽字体、科学/实验感

### 8. 🕵️ 案件侦探（Detective Board）
```css
:root{--bg:#1a1410;--bg-board:#2c241e;--text:#f5e6d0;--text-dim:#a8927a;--amber:#f59e0b;--amber-light:#fbbf24;--cream:#fef3c7;--brown:#78350f;--red:#dc2626;--blue:#3b82f6;--green:#22c55e;--card-bg:rgba(44,36,30,0.75);--radius:4px;--font-hand:'KaiTi','STKaiti','FangSong','Microsoft YaHei',serif}
```
特点：深褐软木板底色、琥珀色灯光、线索卡片、手写体、侦探/推理感

### 9. 🧑‍🔬 人体工学（Ergonomic）
```css
:root{--bg:#f7fafc;--card-bg:#ffffff;--text:#1a202c;--text-dim:#4a5568;--teal:#0d9488;--teal-light:#14b8a6;--teal-bg:rgba(13,148,136,0.06);--red:#e53e3e;--blue:#3182ce;--amber:#d97706;--shadow:0 4px 24px rgba(0,0,0,0.05);--radius:16px}
```
特点：浅灰蓝底、青色主调、干净柔和、大量留白、圆润友好、人体工学感

### 10. 🧰 创意工具箱（Toolbox）
```css
:root{--bg:#1e1b16;--bg2:#2a251f;--text:#f0ebe3;--text-dim:#9a8c7c;--gold:#d4a853;--gold-light:#f0d68a;--red:#e85d4a;--blue:#5b8def;--green:#5bc88d;--purple:#a78bfa;--orange:#f59e0b;--card-bg:rgba(42,37,31,0.85);--card-border:rgba(212,168,83,0.08);--radius:14px;--shadow:0 4px 24px rgba(0,0,0,0.4);--font-mono:'Courier New','Consolas','JetBrains Mono',monospace}
```
特点：深木色底色、金色+多色强调、卡片分类布局、工具箱/策略卡牌感

### 11. 📐 工程蓝图（Blueprint）
```css
:root{--bg:#0a1a3a;--bg2:#0f2248;--line:rgba(255,255,255,0.04);--text:#c8d8ff;--text-dim:#8098cc;--blue:#3b82f6;--cyan:#67e8f9;--white:#e8eeff;--amber:#fbbf24;--red:#ef4444;--card-bg:rgba(15,34,72,0.6);--card-border:rgba(59,130,246,0.15);--radius:0px;--font-tech:'Courier New','Consolas','Lucida Console',monospace}
```
特点：深蓝工程底+白色方格线、蓝/青色线条、等技术字体、锐利直角、精密工程感

### 12. 🔧 创客工坊（Workshop / Maker）
```css
:root{--bg:#2a2520;--bg2:#3d352e;--text:#f0ead8;--text-dim:#a89880;--orange:#e87a30;--yellow:#f5c542;--steel:#7a8a9a;--red:#d94a4a;--green:#5cad6a;--card-bg:rgba(61,53,46,0.7);--card-border:rgba(232,122,48,0.08);--radius:6px;--shadow:0 4px 20px rgba(0,0,0,0.4);--font-mono:'Courier New','Consolas','JetBrains Mono',monospace}
```
特点：深木色工坊底、橙/黄色强调、钢蓝色点缀、pegboard 纹理、手工/创客感

### 13. 🎤 发布会（Stage / Conference）
```css
:root{--bg:#0d0d1a;--stage:#1a1a30;--text:#f0eeff;--text-dim:#8a88b0;--gold:#f5c542;--gold-light:#ffe68a;--violet:#8b5cf6;--cyan:#22d3ee;--pink:#ec4899;--card-bg:rgba(26,26,48,0.7);--card-border:rgba(139,92,246,0.08);--radius:12px;--shadow:0 8px 40px rgba(0,0,0,0.5)}
```
特点：深色舞台底、金色聚光灯效果、紫/粉/青色、帷幕侧边装饰、发布会/showcase 感

### 14. 🏗️ 工程现场（Construction Site）
```css
:root{--bg:#1c1816;--bg2:#25201c;--text:#f0e8e0;--text-dim:#9a8e84;--orange:#e86020;--yellow:#f0b840;--steel:#708090;--concrete:#8a7a6e;--safety:#ff6633;--card-bg:rgba(25,20,18,0.65);--radius:6px}
```
特点：深褐底色+30px 钢蓝网格、橙色安全色、混凝土灰、粗犷/施工现场感

### 15. ⚙️ 流水线车间（Factory Line）
```css
:root{--bg:#f4f6f5;--bg2:#e8ece9;--text:#1e2822;--text-dim:#6b7a72;--factory:#274b6b;--conveyor:#3d6b8c;--belt:#5a8aa5;--amber:#d49a3a;--green:#3a9a6a;--white:#fafcfa;--card-bg:rgba(250,252,250,0.85);--radius:6px}
```
特点：浅灰工业底色、60px 工业蓝竖纹、传送带动画装饰、简明实用、工厂车间感

### 16. 🌐 网络拓扑（Network Topology）
```css
:root{--bg:#0c1220;--bg2:#10182e;--text:#d0d8f0;--text-dim:#6878a8;--cyan:#22d3ee;--teal:#14b8a6;--violet:#8b5cf6;--indigo:#6366f1;--pink:#ec4899;--card-bg:rgba(16,24,46,0.6);--radius:10px}
```
特点：深蓝网络底色+60px 青/紫网格点、节点连线装饰、拓扑图感、科技连接感

### 17. 🎛️ 仪表控制舱（Control Panel）
```css
:root{--bg:#141618;--bg2:#1a1e22;--text:#d0d8e0;--text-dim:#7a8490;--panel:#1e2328;--red:#e8483a;--green:#38c86a;--amber:#e8b030;--cyan:#30b8e8;--blue:#3888d8;--silk:#8898a8;--card-bg:rgba(30,35,40,0.6);--radius:4px}
```
特点：深灰仪表盘底色+24px 暗线网格、红/绿/黄 LED 指示灯装饰、面板直角、控制舱感

---
**选择建议**：根据知识点内容匹配主题。技术发展史→文明展馆/赛博数据流；设计原理→杂志编辑/古典殿堂/太极对话；动手制作→创客工坊/工程现场/流水线；系统分析→网络拓扑/仪表控制舱/实验室；创新构思→创意工具箱/冒险旅程；人机交互→人体工学/案件侦探；展示评价→发布会

## ◈ 输出要求
- 输出**完整的 HTML 代码**（<!DOCTYPE html> 到 </html>）
- 所有 CSS 内嵌在 <style> 标签中
- 所有 JS 内嵌在 <script> 标签中
- 不依赖任何外部资源（无 CDN、无外部字体、无 Google Fonts 导入）
- 内容准确、有教育意义、深度适当，与 {topic} 紧密相关
- 纯 HTML 输出，不要加任何解释说明
- 在 <style> 末尾添加一行注释：/* auto-generated by SmartKBS AI */
"""

QUIZ_HTML_PROMPT = """你是一位专业的教育游戏 HTML 设计师。请根据以下知识点，生成一个**太空/科幻主题的互动答题 HTML 页面**。

## ◈ 知识点
{topic}

## ◈ 学科 & 年级
{subject_info}

## ◈ 参考知识
{rag_context}

## ◈ 参考 HTML 结构（请严格按照此模式生成）

### 整体风格（太空科幻主题）
- 深色背景 #0a0a1a / #0f0f2e
- 霓虹色：青色 #00f0ff、紫色 #8833ff、金色 #ffd700、粉色 #ff3377、绿色 #00ff88
- 玻璃态效果：background:rgba(255,255,255,.06); backdrop-filter:blur(16px); border:1px solid rgba(255,255,255,.12)
- 圆角 16px / 10px
- 字体：'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif
- Canvas 动态星空背景（画布覆盖全屏，z-index:0，星星闪烁 + 缓慢移动）

### CSS 变量定义
```css
:root {
  --bg-deep:#0a0a1a; --bg-mid:#0f0f2e;
  --cyan:#00f0ff; --cyan-dim:rgba(0,240,255,.3);
  --purple:#8833ff; --purple-dim:rgba(136,51,255,.25);
  --gold:#ffd700; --gold-dim:rgba(255,215,0,.25);
  --pink:#ff3377; --green:#00ff88; --red:#ff3355;
  --glass:rgba(255,255,255,.06); --glass-border:rgba(255,255,255,.12);
  --radius:16px; --radius-sm:10px;
  --font:'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif;
}
```

### 页面布局结构
整个页面在一个 #app 容器中（position:relative; z-index:1），包含 5 个场景 div，用 .hidden 类切换显示：

**1. header 头部**：flex 布局，包含标题 h1（渐变文字）和 `.round-indicator`（5 个圆点指示器）

**2. 场景 0 - 设置界面** `#sceneSetup`：
```html
<div class="scene" id="sceneSetup">
  <div class="scene-title">🚀 标题</div>
  <div class="setup-group">
    <div class="setup-row">
      <label>🌍 选择年级</label>
      <select id="gradeSelect"><option value="高一">高一年级</option></select>
    </div>
    <div class="setup-row">
      <label>🏫 选择班级</label>
      <select id="classSelect" disabled><option>-- 请先选择年级 --</option></select>
    </div>
    <div class="setup-row">
      <button class="btn-primary" id="btnStart" disabled>⚡ 启动</button>
    </div>
  </div>
</div>
```

**3. 场景 1 - 点名抽取** `#scenePick`：
- 旋转光环动画（3 个嵌套 .pick-ring 圆圈，不同大小 + 不同方向旋转）
- 大号姓名显示 .pick-name（5rem，滚动闪烁效果 .rolling，揭晓动画 .result）
- 班级标签 .pick-class-tag
- 按钮：🔄 开始抽取 / ✅ 确认开始答题 / ↻ 重抽

**4. 场景 2 - 答题** `#sceneQuiz`：
- 题号 .q-number + 知识点标签 .q-principle
- 题目文本 .q-text
- 选项网格 .options-grid（grid-template-columns:1fr 1fr）
- 每个选项按钮 .option-btn 含 .opt-label（圆形字母 A/B/C/D）
- 状态类：.selected（选中）、.correct（正确高亮绿色）、.wrong（错误红色+shake动画）、.disabled
- 反馈框 .feedback-box（.correct-fb 绿色 / .wrong-fb 红色）
- "下一题"按钮 .btn-next

**5. 场景 3 - 计分结算** `#sceneScore`：
- 分数大号显示 .score-big（+10，弹出动画）
- 详细信息格 .score-detail > .score-stat
- 能量条 .energy-bar-wrap > .energy-bar-bg > .energy-bar-fill（渐变填充 + 光泽动画）
- "进入下一组"按钮 .btn-next

**6. 场景 4 - 最终排行榜** `#sceneFinal`：
- 排行榜表格 .final-table（#、姓名、班级、答对题数、获得积分）
- 错题解析区 .review-section（.rev-student / .rev-item / .rev-opt）
- "查看错题解析"按钮 #btnReview

### JavaScript 逻辑结构（必须包含以下核心函数）

```javascript
// 工具函数
function $(id){return document.getElementById(id);}
function show(id){$(id).classList.remove('hidden');}
function hide(id){$(id).classList.add('hidden');}
function shuffle(a){...}

// 特效函数
function showToast(icon, msg, score)     // Toast 通知
function fireParticles(x, y, color, count) // 粒子爆发特效

// 核心游戏流程
let state = { grade, class, students, available, picks, currentRound, currentQ, ... }
GROUPS = [] // 10 题分 5 组，每组 2 题

function startRound(roundIdx)     // 开始一轮
function startPick()              // 点名阶段
function startQuiz()              // 答题阶段
function showQuestion()           // 显示当前题目
function handleAnswer(label)      // 处理答题
function showScore()              // 显示计分
function showFinal()              // 显示最终结果
function buildReview()            // 生成错题解析
```

### 题目数据格式（支持题库真实题目 + AI 补充 + 配图 + 公式）
```javascript
const QUESTION_BANK = [
  {
    question: "题目文本",
    options: {A:"选项A", B:"选项B", C:"选项C", D:"选项D"},
    answer: "A",        // 正确答案字母
    principle: "知识点标签",  // 如"实用原则"
    explanation: "解析文本",
    // 可选配图（SVG 技术图示）
    svg_code: '<svg viewBox="0 0 400 300">...</svg>'
  }
];
```

**重要 — 题目来源原则**：
1. 如果 prompt 中提供了「题库提供的真实题目」JSON 数据块，请**优先使用这些真实题目**嵌入 HTML，不要修改题目文本、选项、答案和解析
2. 如果真实题目数量不足（如只检索到 3 道但需要 10 道），保留真实题目并补充新题目（新题目按同样数据格式添加）
3. 如果题目包含 `svg_code` 字段，请在题目卡片中渲染该 SVG（宽度自适应，显示在题目文本下方或旁边）
4. 如果题目或解析中包含 KaTeX 公式（$...$ 或 $$...$$），请在 HTML 中引入 KaTeX CDN：`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">` 并使用 `renderMathInElement()` 自动渲染

## ◈ 可选视觉风格（共 20 种主题，选择其中一种使用）
**重要**：根据知识点内容选择最合适的主题风格。每个主题名对应其 CSS 变量前缀（如 `--t1-*`），在生成时将所有 CSS 类名和变量按所选主题统一命名。

### 1. 🚀 星际太空（太空科幻）
```css
:root{--bg-deep:#0a0a1a;--bg-mid:#0f0f2e;--cyan:#00f0ff;--cyan-dim:rgba(0,240,255,.3);--purple:#8833ff;--purple-dim:rgba(136,51,255,.25);--gold:#ffd700;--gold-dim:rgba(255,215,0,.25);--pink:#ff3377;--green:#00ff88;--red:#ff3355;--glass:rgba(255,255,255,.06);--glass-border:rgba(255,255,255,.12);--radius:16px;--radius-sm:10px;--font:'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif}
```
特点：深色背景、霓虹色点缀、玻璃态效果、Canvas 动态星空背景、圆点进度指示器

### 2. 🌿 知识森林（自然绿色）
```css
:root{--t1-green:#2d7d46;--t1-teal:#1a8b7a;--t1-gold:#d4a017;--t1-brown:#8b5e3c;--t1-red:#c0392b;--t1-blue:#2c6b9e;--t1-bg:#f0f4e8;--t1-card:#ffffff;--t1-text:#1a2a1a;--t1-text-dim:#6a7a5a;--t1-line:rgba(45,125,70,.12);--font:'Space Grotesk','Segoe UI',sans-serif;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：浅绿背景、白色圆角卡片、顶部绿色渐变条、菱形进度指示器、柔和亲切

### 3. 🔧 工业蓝图（深蓝工程）
```css
:root{--bp-dark:#0d1b3e;--bp-mid:#142850;--bp-light:#1e3a5f;--bp-grid:rgba(255,255,255,.06);--bp-line:rgba(255,255,255,.18);--bp-gold:#d4a843;--bp-cyan:#5bc0eb;--bp-text:#e8e4d8;--bp-text-dim:#9a9aaa;--bp-card:rgba(20,40,80,.7);--bp-green:#4ecdc4;--bp-red:#ff6b6b;--font-mono:'JetBrains Mono','Cascadia Code','Consolas',monospace;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：深蓝底+白色网格线、半透卡片、黄铜色点缀、等宽字体标题、精密机械感

### 4. 🎨 孟菲斯（活泼几何）
```css
:root{--m-blue:#226ce0;--m-yellow:#ffb703;--m-pink:#ff6b9d;--m-green:#06d6a0;--m-orange:#fb8500;--m-purple:#9b5de5;--m-red:#e63946;--m-bg:#f8f4e8;--m-card:#ffffff;--m-text:#1a1a2e;--m-text-dim:#7a7a8a;--m-shadow:rgba(34,108,224,.12);--font:'Space Grotesk','Segoe UI',sans-serif;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：米白底、高饱和几何色块、活泼明亮、怪诞装饰、圆角卡片+阴影

### 5. 💥 波普漫画（Pop Art）
```css
:root{--pop-red:#e63946;--pop-blue:#1d3557;--pop-yellow:#ffd166;--pop-cyan:#06d6a0;--pop-pink:#ff6b9d;--pop-orange:#ff8800;--pop-white:#f1faee;--pop-dot:#ccc;--text:#1a1a1a;--text-light:#f0f0f0;--font:'Oswald','Arial Black',sans-serif;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：漫画网点背景、粗边框 4px solid、box-shadow:6px 6px 0 #000、Oswald 字体、高饱和色、弹出动画

### 6. 🌅 蒸汽波（Vaporwave）
```css
:root{--bg1:#0a0a2e;--bg2:#1a0a3e;--pink:#ff6ec7;--pink-glow:rgba(255,110,199,.25);--cyan:#00d4ff;--cyan-glow:rgba(0,212,255,.2);--purple:#a855f7;--gold:#fbbf24;--sunset:#ff7eb3;--text:#f0e6ff;--text-dim:#8877bb;--card-bg:rgba(10,10,50,.7);--font:'Orbitron','Courier New',monospace;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：深紫蓝渐变、霓虹粉/青、棕榈树剪影装饰、Orbitron 字体、发光文字、故障效果

### 7. 📚 未来教室（玻璃拟态）
```css
:root{--bg:#e8edf5;--glass-bg:rgba(255,255,255,.55);--glass-bg-dark:rgba(255,255,255,.35);--glass-border:rgba(255,255,255,.6);--glass-shadow:0 8px 32px rgba(31,38,135,.12);--cyan:#06b6d4;--cyan-soft:rgba(6,182,212,.15);--purple:#8b5cf6;--purple-soft:rgba(139,92,246,.12);--gold:#f59e0b;--green:#10b981;--red:#ef4444;--text:#1e293b;--text-dim:#64748b;--radius:20px;--radius-sm:14px;--font:'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif}
```
特点：浅灰蓝底、玻璃拟态卡片（backdrop-filter:blur）、浮动几何装饰、柔和圆角

### 8. 🏆 竞技场（游戏化）
```css
:root{--bg-dark:#0d0d1a;--bg-card:#1a1a30;--bg-card-hover:#222244;--gold:#ffd700;--gold-dim:rgba(255,215,0,.15);--cyan:#00f0ff;--cyan-dim:rgba(0,240,255,.15);--red:#ff3355;--red-dim:rgba(255,51,85,.15);--green:#00ff88;--green-dim:rgba(0,255,136,.12);--purple:#8833ff;--orange:#ff8800;--text:#e8e8f0;--text-dim:#8888aa;--border:rgba(255,255,255,.08);--border-glow:rgba(255,215,0,.2);--radius:16px;--radius-sm:10px;--font:'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif}
```
特点：深色底+像素网格叠加、金色强调、游戏化UI、发光边框、竞技感

### 9. 💻 赛博终端（Cyber Terminal）
```css
:root{--bg:#0a0e0a;--green:#00ff41;--green-dim:rgba(0,255,65,.12);--green-glow:rgba(0,255,65,.3);--orange:#ff8800;--amber:#ffb000;--red:#ff3355;--cyan:#00ccff;--text:#c0c0b0;--text-dim:#556655;--text-bright:#e0e0d0;--border:rgba(0,255,65,.15);--radius:0px;--font:'Share Tech Mono','Courier New',monospace}
```
特点：黑底绿字终端风格、等宽字体、CRT 扫描线效果、锐利直角、命令行交互感

### 10. ○ 极简（Minimalist）
```css
:root{--bg:#fafafa;--surface:#ffffff;--border:#e0e0e0;--border-light:#eeeeee;--text:#1a1a1a;--text-dim:#999999;--text-bright:#000000;--accent:#333333;--accent-light:#666666;--green:#2e7d32;--green-bg:rgba(46,125,50,.06);--red:#c62828;--red-bg:rgba(198,40,40,.06);--gold:#d4a017;--radius:4px;--font:'Inter','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：黑白灰、大留白、细线边框、极简克制、干净精致

### 11. 🎮 像素风（8-Bit Retro）
```css
:root{--bg:#1a1a2e;--pixel-bg:#16213e;--pixel-card:#1f2d50;--pixel-border:#4a6fa5;--pixel-light:#7eb5e0;--pixel-gold:#f0c040;--pixel-red:#e74c5e;--pixel-green:#4ade80;--pixel-cyan:#48d1cc;--pixel-pink:#ff6b9d;--pixel-yellow:#ffe066;--text:#e0e8f0;--text-dim:#7a8aa0;--radius:0px;--font:'Press Start 2P','Courier New',monospace;--font-body:'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif}
```
特点：深色底+16px 像素网格、像素锯齿边框、鲜艳色块、复古游戏感

### 12. 🌳 森系（Forest Nature）
```css
:root{--bg:#f5f0e8;--bg-alt:#faf7ef;--surface:#fffbee;--wood:#8b7355;--wood-light:#c4a97b;--leaf:#4a8c5c;--leaf-light:#6db37b;--leaf-dark:#2d5a3e;--moss:#7ca67c;--bark:#6b5b4a;--text:#3a2e24;--text-dim:#8a7a6a;--gold:#b8860b;--cream:#fff8ea;--radius:12px;--font:'Inter','Microsoft YaHei','PingFang SC',sans-serif;--font-serif:'Noto Serif SC','STSong',serif}
```
特点：暖米底、木质暖色+叶绿、柔和自然、serif 标题、植物纹理

### 13. ✏️ 速写风（Sketch）
```css
:root{--sk-paper:#f7f3eb;--sk-card:#f0e9da;--sk-ink:#2a2018;--sk-ink-dim:#8a7a6a;--sk-accent:#d4a030;--sk-line:#c4b8a8;--sk-green:#4a7c3f;--sk-red:#c04040;--sk-blue:#3a6fa5;--font-hand:'Caveat','Comic Sans MS',cursive;--font-body:'Segoe UI',system-ui,sans-serif;--font-mono:'Courier New',monospace}
```
特点：纸张纹理底、手写风格标题（Caveat 字体）、螺旋线圈装饰、炭笔线条

### 14. 🪚 木工坊（Woodworking）
```css
:root{--mw-bg:#e8dcc8;--mw-card:#d4c4a8;--mw-dark:#3d2b1f;--mw-text:#2b1f14;--mw-dim:#8b7355;--mw-gold:#c8963e;--mw-orange:#e07c3c;--mw-green:#5a7d3a;--mw-red:#b84a3a;--mw-blue:#4a6fa5;--mw-warm:#f5e6c8;--font:'Georgia','Times New Roman',serif;--font-body:'Segoe UI',system-ui,sans-serif;--font-mono:'Courier New',monospace}
```
特点：木色暖调、木质横纹背景、仿古卡片、Georgia serif 字体、木工/手作风

### 15. 🎤 发布会（Stage/Launch）
```css
:root{--st-bg:#0a0a12;--st-card:#14141e;--st-text:#eaeaea;--st-dim:#6a6a7a;--st-gold:#d4a843;--st-red:#e85050;--st-green:#46b88c;--st-blue:#5b9ae0;--st-purple:#a074d9;--font:'Inter','Segoe UI',system-ui,sans-serif;--font-body:'Inter','Segoe UI',system-ui,sans-serif;--font-mono:'JetBrains Mono','Courier New',monospace}
```
特点：深色舞台背景、金色聚光灯效果、极简卡片+顶部金色细线、发布会/展示感

### 16. 📐 工程蓝图（Engineering Blueprint）
```css
:root{--bp-blue:#1a5276;--bp-light:#2980b9;--bp-accent:#f39c12;--bp-grid:#b0c4de;--bp-bg:#e8eef5;--bp-card:#f5f8fc;--bp-text:#1a2a3a;--bp-dim:#5a7a8a;--bp-line:#2980b9;--bp-green:#27ae60;--bp-red:#e74c3c;--font:'Inconsolata','Courier New',monospace;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：蓝底白线网格（40px）、蓝图卡片、工程标题装饰├ ┤、等宽字体、理性结构感

### 17. 🔷 流程图风（Flowchart）
```css
:root{--fl-green:#2d8f5c;--fl-teal:#1a9e8f;--fl-orange:#e8913a;--fl-red:#d94a4a;--fl-blue:#3a7bd5;--fl-bg:#f5f7fa;--fl-card:#ffffff;--fl-text:#1a2a3a;--fl-text-dim:#6a7a8a;--fl-line:rgba(45,143,92,.12);--font:'Space Grotesk','Segoe UI',sans-serif;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：浅灰底、白色卡片、绿色强调、菱形进度指示器、顶部渐变条、简洁现代

### 18. ⚡ 电路板风（Circuit Board）
```css
:root{--cb-dark:#0d1b2a;--cb-green:#00ff41;--cb-cyan:#00d4ff;--cb-purple:#7b2d8e;--cb-orange:#ff9500;--cb-red:#ff3355;--cb-bg:#0f1923;--cb-card:#1a2d3d;--cb-text:#e0e8f0;--cb-text-dim:#6a8a9a;--cb-line:rgba(0,255,65,.08);--font:'Space Grotesk','Segoe UI',sans-serif;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：深蓝黑底、绿色电路色 #00ff41、方形块进度指示器、电路线装饰、科技硬核

### 19. 📊 仪表盘风（Dashboard）
```css
:root{--db-dark:#1a1a2e;--db-gray:#2a2a3e;--db-red:#e63946;--db-green:#2ec4b6;--db-yellow:#ffbe0b;--db-blue:#3a86ff;--db-orange:#fb5607;--db-bg:#12121e;--db-card:#1e1e32;--db-text:#e8e8f0;--db-text-dim:#6a6a8a;--db-line:rgba(255,255,255,.06);--font:'Space Grotesk','Segoe UI',sans-serif;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：深色仪表盘背景、圆形进度指示器、黄色+蓝色强调、红黄绿蓝多色配色

### 20. 🔵 科技蓝（Tech Blue）
```css
:root{--t2-blue:#1a5c9e;--t2-cyan:#1a9e8f;--t2-amber:#e8913a;--t2-red:#d94a4a;--t2-indigo:#3a5bd5;--t2-bg:#e8eef8;--t2-card:#ffffff;--t2-text:#1a2a3a;--t2-text-dim:#5a7a8a;--t2-line:rgba(26,92,158,.12);--font:'Space Grotesk','Segoe UI',sans-serif;--font-body:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif}
```
特点：浅蓝底、白色圆角卡片、科技蓝主色+琥珀色强调、方形进度指示器

---
**选择建议**：根据知识点内容匹配主题。技术概念→星际/蓝图/电路板；设计原理→孟菲斯/波普/蒸汽波；实践制作→木工坊/速写风；理论分析→极简/知识森林/科技蓝；评价交流→发布会/竞技场

## ◈ API 调用说明（互动答题专用）

互动答题页面需要通过与后端 API 交互来实现真实课堂功能。所有 API 调用均通过 `fetch()` 完成，路径以 `/api/` 开头。以下是从参考 HTML 中提取的完整 API 调用模式：

### 1. 获取教师标识（从 URL 路径解析）
```javascript
// 从页面 URL 中提取教师用户名（所有互动答题文件通用）
const pathMatch = window.location.pathname.match(/\\/api\\/files\\/([^\\/]+)\\/html\\//);
const TEACHER = (pathMatch ? pathMatch[1] : '') || '';
```

### 2. 获取年级列表
```javascript
// GET /api/rollcall/grades
// 返回: string[] (如 ["高一", "高二"])
async function initGrades() {
  try {
    const r = await fetch('/api/rollcall/grades');
    const grades = await r.json();
    // 渲染到 gradeSelect 下拉框
  } catch(e) { /* 失败处理 */ }
}
```

### 3. 获取班级列表
```javascript
// GET /api/rollcall/classes?grade={grade}&teacher={TEACHER}
// 返回: string[] (如 ["高一(1)班", "高一(2)班"])
async function loadClasses() {
  try {
    const r = await fetch('/api/rollcall/classes?grade=' + encodeURIComponent(g) + '&teacher=' + TEACHER);
    const classes = await r.json();
    // 渲染到 classSelect 下拉框
  } catch(e) { /* 失败处理 */ }
}
```

### 4. 获取学生名单
```javascript
// GET /api/rollcall/students?grade={grade}&class={class}&teacher={TEACHER}
// 返回: Student[] (数组，每项有 name 字段)
async function loadStudents(grade, cls) {
  try {
    const r = await fetch('/api/rollcall/students?grade=' + encodeURIComponent(grade) + '&class=' + encodeURIComponent(cls) + '&teacher=' + TEACHER);
    const data = await r.json();
    return data.map(s => s.name);  // 提取姓名数组
  } catch(e) { return []; }
}
```

### 5. 随机点名（抽取一名学生）
```javascript
// POST /api/rollcall/pick
// Body: { grade, class, teacher }
// 返回: { student: "姓名" } 或 { error: "..." }
fetch('/api/rollcall/pick', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grade: state.grade, class: state.class, teacher: TEACHER })
}).then(d => d.json()).then(d => {
  if (d.error) { /* 显示错误 */ return; }
  const student = d.student;
  // 显示被点名学生
}).catch(() => { /* 网络异常处理 */ });
```

### 6. 标记学生已答题
```javascript
// POST /api/rollcall/mark
// Body: { grade, class, student, result, teacher }
fetch('/api/rollcall/mark', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grade, class, student, result: 'quiz', teacher: TEACHER })
}).catch(() => {});
```

### 7. 保存积分
```javascript
// POST /api/scores/score
// Body: { grade, class, name, points, teacher }
// 返回: 200 OK 表示成功
function saveScore(grade, cls, name, points) {
  fetch('/api/scores/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grade, class: cls, name, points, teacher: TEACHER })
  }).then(r => {
    if (r.ok) showToast('💰', '积分已保存', '+' + points);
    else showToast('⚠️', '积分存储异常');
  }).catch(() => {
    showToast('📝', '本地模式 · 分数已记录');
  });
}
```

### 8. 保存答题记录
```javascript
// POST /api/rollcall/save-record
// Body: { grade, class, student, type, title, correctCount, totalQuestions, points, answers, teacher }
function saveRecord(grade, cls, student, correctCount, totalQ, points, answers, title) {
  fetch('/api/rollcall/save-record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grade, class: cls, student, type: '互动答题',
      title: title || '', correctCount, totalQuestions: totalQ,
      points, answers: answers || [], teacher: TEACHER
    })
  }).catch(() => {});
}
```

### 重要说明
- 所有 API 路径以 `/api/` 开头，部署时自动适配后端地址
- 所有 API 调用必须有 `.catch()` 异常处理，后端不可用时降级为本地模式
- `TEACHER` 变量在页面加载时从 URL 自动提取，无需用户配置
- 当 API 调用失败时，页面应使用模拟数据（预置的学生名单）继续运行，不应卡死
- 保存积分和记录时使用 fire-and-forget 模式（不等待返回结果）

## ◈ 输出要求
- 输出**完整的 HTML 代码**（<!DOCTYPE html> 到 </html>）
- 所有 CSS 内嵌在 <style> 标签中
- 所有 JS 内嵌在 <script> 标签中
- 所有题目数据硬编码在 JS 中（按照 QUESTION_BANK 格式）
- 年级/班级/学生数据通过 API 实时加载，同时内置模拟数据作为 API 不可用时的降级方案
- 不依赖外部资源（无 CDN、无 Google Fonts 导入）
- 纯 HTML 输出，不要加任何解释说明
- 在 <style> 末尾添加一行注释：/* auto-generated by SmartKBS AI */
"""

PRACTICE_HTML_PROMPT = """你是一位专业的教育测试 HTML 设计师。请根据以下知识点，生成一个**章节练习题 HTML 页面**。

## ◈ 知识点
{topic}

## ◈ 学科 & 年级
{subject_info}

## ◈ 参考知识
{rag_context}

## ◈ 参考 HTML 结构（请严格按照此模式生成）

### 整体风格
请从以下主题中选择一种风格进行设计：

1. **🌌 科技深色**：深蓝渐变背景 + 毛玻璃卡片 + 霓虹蓝/金色点缀（参考 1.2技术世界中的设计练习题.html）
```css
body { font-family:'Roboto',sans-serif; background:linear-gradient(135deg,#1a2a6c,#2c3e50); color:#ecf0f1; }
.question-card { background:rgba(30,40,60,0.85); backdrop-filter:blur(10px); border-radius:15px; border:1px solid rgba(52,152,219,.3); }
.feedback.correct { background:rgba(46,204,113,.2); color:#2ecc71; }
.feedback.incorrect { background:rgba(231,76,60,.2); color:#e74c3c; }
```

2. **📋 白底卡片**：浅灰渐变背景 + 白色圆角卡片 + 深蓝 header（参考 1.1走进技术世界练习题.html）
```css
body { font-family:'Microsoft YaHei',sans-serif; background:linear-gradient(135deg,#f5f7fa,#c3cfe2); margin:0; padding:20px; color:#333; }
.container { max-width:900px; margin:0 auto; background:white; border-radius:15px; box-shadow:0 10px 30px rgba(0,0,0,0.15); }
header { background:linear-gradient(to right,#4b6cb7,#182848); color:white; padding:25px; text-align:center; }
.question-card { background:#f8f9fa; border-radius:12px; padding:20px; margin:15px 25px; border-left:4px solid #4b6cb7; }
```

3. **💠 赛博霓虹**：深色背景 + 青色发光边框 + 科技感点缀（参考 1.4方案的构思及方法练习题.html）
```css
:root { --primary:#0ef; --primary-dark:#0be; --correct:#0f8; --incorrect:#f44; --bg-dark:#0a0c15; --card-bg:rgba(16,24,48,0.5); --border-glow:0 0 15px rgba(0,239,255,0.3); }
body { font-family:'Segoe UI','Microsoft YaHei',sans-serif; background:linear-gradient(135deg,#0a0c15,#1a1f3c); color:#fff; }
.question-card { background:var(--card-bg); border:1px solid rgba(0,239,255,0.2); border-radius:12px; padding:20px; margin-bottom:20px; box-shadow:var(--border-glow); }
```

4. **🔮 紫色渐变**：紫蓝渐变背景 + 白色圆角卡片 + 柔和阴影（参考 2.1结构及其设计练习题.html）
```css
body { font-family:'Microsoft YaHei','Segoe UI',sans-serif; background:linear-gradient(135deg,#667eea,#764ba2); min-height:100vh; padding:20px; }
.header { background:rgba(255,255,255,0.95); border-radius:20px; padding:30px; margin-bottom:25px; box-shadow:0 10px 40px rgba(0,0,0,0.2); }
.header h1 { color:#667eea; }
.question-card { background:rgba(255,255,255,0.95); border-radius:16px; padding:24px; margin-bottom:20px; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
```

5. **🤖 AI 智能**：浅灰渐变背景 + 紫蓝渐变 header + 公式支持（参考 3_技术的性质_20260617_063501_练习.html）
```css
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:linear-gradient(135deg,#f5f7fa,#c3cfe2); min-height:100vh; padding:20px; }
.header { background:linear-gradient(135deg,#667eea,#764ba2); border-radius:16px; padding:32px 40px; color:white; margin-bottom:24px; box-shadow:0 8px 32px rgba(102,126,234,0.3); }
.question-card { background:white; border-radius:12px; padding:24px; margin-bottom:20px; box-shadow:0 2px 12px rgba(0,0,0,0.08); }
```

### 通用页面结构（所有主题通用）
1. **头部**：标题 h1（.container > header 或 .header），可包含副标题
2. **进度条**：.progress-bar-container > .progress-bar（渐变，transition width 0.4s）

### 页面结构
1. **头部**：标题 h1（.container > header）使用 Orbitron 字体 + 发光 text-shadow，副标题 .subtitle
2. **进度条**：.progress-bar-container > .progress-bar（渐变蓝→金，transition width 0.4s）
3. **题目列表** #questions-container：
   - 每道题一个 .question-card
   - 内含：.question-number（题号，金色）、.question-text（题目文本）、.options（4 个 radio label）
   - 每个选项有 input[type="radio"] + 选项文本
   - 每题底部 .action-row：.submit-btn（绿色渐变）+ .feedback（正确/错误反馈）
4. **"查看最终成绩"按钮** #show-results-btn（初始隐藏）
5. **结果弹窗** #results-overlay（全屏遮罩，flex 居中）：
   - .results-content：渐变背景 #2c3e50→#1a2a6c，圆角 20px，含：
   - .results-header：标题"挑战完成！" + .summary-stats（总分/答对/答错/未答）
   - .chart-container：Chart.js 画布（响应式，300px 高度）
   - #detailed-results：每题解析列表（.detail-item，左框彩色边框）
   - .close-btn：红色关闭按钮

### 题目数据格式（支持题库真实题目 + AI 补充 + 配图 + 公式）
```javascript
const questions = [
  {
    id: 1,
    text: "题目文本",
    options: [
      {text: "A. 选项A", value: "A"},
      {text: "B. 选项B", value: "B"},
      {text: "C. 选项C", value: "C"},
      {text: "D. 选项D", value: "D"}
    ],
    correctAnswer: "B",
    explanation: "详细解析文本"
  }
];
// 可包含判断（true_false）题：options 只有两项 {text:"A. 正确", value:"A"}, {text:"B. 错误", value:"B"}
```

### JavaScript 逻辑
```javascript
let userAnswers = {};        // {questionId: selectedValue}
let answerStatus = {};       // {questionId: 'correct'|'incorrect'|'unanswered'}

function renderQuestions()   // 动态生成所有题目 HTML
function handleSingleSubmit(questionId)  // 单题提交 + 反馈显示 + 禁用选项
function updateProgressBar() // 更新进度条宽度
function checkAllAnswered()  // 全部答完后显示"查看最终成绩"按钮
function showResults()       // 显示结果弹窗 + Chart.js 图表 + 解析列表

// 结果弹窗中的 Chart.js 配置
new Chart(ctx, {
  type: 'doughnut',
  data: {
    labels: ['答对','答错','未答'],
    datasets: [{ data: [correctCount, incorrectCount, unansweredCount],
      backgroundColor: ['rgba(46,204,113,.7)','rgba(231,76,60,.7)','rgba(243,156,18,.7)'] }]
  },
  options: { responsive: true, plugins: { legend: { labels: { color:'#ecf0f1' } } } }
});
```

### 动画要求
- 淡入动画：@keyframes fadeIn / fadeInDown
- 进度条平滑过渡
- 结果弹窗淡入效果
- 卡片悬停过渡

## ◈ 输出要求
- 输出**完整的 HTML 代码**（<!DOCTYPE html> 到 </html>）
- 所有 CSS 内嵌在 <style> 标签中
- 所有 JS 内嵌在 <script> 标签中
- 引用 Chart.js CDN：`<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`
- 题目数量：10-15 道（含选择题和少量判断题），与 {topic} 紧密相关
- 纯 HTML 输出，不要加任何解释说明
- 在 <style> 末尾添加一行注释：/* auto-generated by SmartKBS AI */
"""

CUSTOM_HTML_PROMPT = """你是一位专业的 HTML 设计师。请根据以下用户需求，生成一个完整的 HTML 页面。

## ◈ 用户需求
{custom_prompt}

## ◈ 学科 & 年级（供参考）
{subject_info}

## ◈ 通用设计要求

### 可选视觉主题（共 10 种，根据需求选择最合适的主题使用）

**重要**：严格遵循所选主题的配色方案、视觉特征和装饰元素。如果用户指定了主题，必须使用该主题风格。

### 1. 💀 赛博朋克 2077（Cyberpunk）
```css
:root{--neon-cyan:#00f0ff;--neon-magenta:#ff00aa;--neon-yellow:#ffe600;--dark-bg:#0a0a0f;--card-bg:rgba(10,10,20,0.7);--text:#c0c0d0}
```
特点：Canvas 粒子网络背景、霓虹渐变（青/品/黄）、60px 网格脉冲动画、扫描线覆盖层、故障效果

### 2. 🪟 玻璃拟态（Glassmorphism）
```css
:root{--glass-bg:rgba(255,255,255,0.12);--glass-border:rgba(255,255,255,0.2);--glass-shadow:rgba(31,38,135,0.12);--text-primary:#1a1a2e;--text-secondary:rgba(26,26,46,0.7);--accent-1:#667eea;--accent-2:#f093fb;--accent-3:#4facfe}
```
特点：毛玻璃卡片（backdrop-filter:blur(20px)）、浮动光晕渐变球体（blur(80px)）、深色渐变背景、弹性动画

### 3. 🌅 合成波日落（Synthwave Sunset）
```css
:root{--sunset-top:#ff6b35;--sunset-mid:#ff2060;--sunset-bot:#7b2d8e;--neon-pink:#ff2a7a;--neon-blue:#00d4ff;--grid-color:rgba(255,42,122,0.15);--text:#e0d0ff}
```
特点：Canvas 透视网格、日落放射线渐变、霓虹文字发光（drop-shadow）、标题浮动动画、80s 复古

### 4. 📜 暗黑学院（Dark Academia）
```css
:root{--parchment:#f4e8c1;--parchment-dark:#e6d5a8;--ink:#2c1810;--ink-light:#5c3a28;--accent:#8b4513;--accent-gold:#b8860b;--fabric:#3a2a1a;--text-body:#3a2a1a}
```
特点：羊皮纸底色+SVG 噪点纹理、Georgia/Noto Serif SC 衬线字体、首字下沉 dropcap、装饰性分隔线、复古学术

### 5. 🌌 宇宙星云（Cosmic Nebula）
```css
:root{--deep-space:#05050a;--nebula-purple:#6b21a8;--nebula-blue:#1e3a8a;--nebula-pink:#ec4899;--star-white:rgba(255,255,255,0.9);--text-primary:rgba(255,255,255,0.9);--text-secondary:rgba(255,255,255,0.55);--glow:rgba(107,33,168,0.3)}
```
特点：Canvas 闪烁星系粒子、星云光晕漂移（blur(120px)）、渐变文字、鼠标视差效果、深空背景

### 6. 🌿 植物自然（Botanic Nature）
```css
:root{--moss:#2d4a22;--leaf:#4a7c3f;--sage:#8a9a6c;--cream:#f5f0e8;--earth:#8b7355;--sky:#c8d8c0;--text-dark:#1a2e15;--text-light:#4a5a3a}
```
特点：SVG 有机曲线浮动、植物柔和色系（苔绿/叶绿/鼠尾草）、叶片装饰摇摆动画、温暖自然

### 7. ☯️ 极简禅意（Minimal Zen）
```css
:root{--white:#fafaf7;--off-white:#f2f0eb;--light-gray:#e2dfd8;--ink:#2c2a28;--ink-light:#6b6864;--accent:#c73e3a;--gold:#b8860b;--charcoal:#3a3835}
```
特点：Enso 禅圆 SVG 呼吸动画、极致留白、侘寂美学、Noto Serif SC 衬线、细线分隔、克制优雅

### 8. 🏙️ 新东京（Neo Tokyo）
```css
:root{--night:#0a0a14;--night2:#12121e;--red:#ff1a4a;--cyan:#00e5ff;--yellow:#ffd600;--pink:#ff2d78;--text:#d0d0e0;--text-dim:rgba(208,208,224,0.5)}
```
特点：CSS 生成建筑群剪影、霓虹色块、窗户闪烁动画、滚动驱动视差条纹、都市夜景

### 9. 👑 奢华金（Luxury Gold）
```css
:root{--obsidian:#0c0a08;--charcoal:#1a1816;--gold:#c9a84c;--gold-light:#e8d48b;--gold-dark:#8a7028;--cream:#f5f0e0;--text:rgba(255,255,255,0.85);--text-dim:rgba(255,255,255,0.45)}
```
特点：暗黑曜石底+噪点纹理、金色光晕球体（blur(100px)）、金色竖线装饰、Georgia serif 字体、奢华高级

### 10. 🏗️ 数字粗野（Digital Brutalist）
```css
:root{--bg:#f5f5f0;--black:#111;--red:#d42;--blue:#2266ff;--yellow:#ffdd00;--gray:#888;--light-gray:#ddd;--accent:var(--red)}
```
特点：40px 裸露网格叠加、Impact/Arial Black 重型字体、粗野边框 4px solid red、黑底红边顶栏、极简粗暴

### 技术要求
- 使用现代 CSS 布局（Flexbox / Grid）
- 使用 CSS 变量管理主题色
- 响应式设计（适配移动端）
- 中文字体支持（Microsoft YaHei / PingFang SC）
- 所有 CSS 内嵌在 <style> 标签中
- 所有 JS 内嵌在 <script> 标签中
- 尽量减少外部依赖，如需 CDN 请注明
- 确保页面功能完整可用
- 适当使用 CSS 动画提升交互体验

## ◈ 输出要求
- 输出**完整的 HTML 代码**（<!DOCTYPE html> 到 </html>）
- 纯 HTML 输出，不要加任何解释说明
- 在 <style> 末尾添加一行注释：/* auto-generated by SmartKBS AI */
"""


# ── 主题数据（供前端选择和后端引用）──

ANIMATION_THEMES = [
    {"id": "magazine", "name": "杂志编辑", "icon": "📰", "desc": "黑白灰、serif 标题、干净简洁"},
    {"id": "cyber", "name": "赛博数据流", "icon": "💿", "desc": "深色+霓虹粉/蓝、科技感发光"},
    {"id": "museum", "name": "文明展馆", "icon": "🏛️", "desc": "羊皮纸+金色、仿古风格"},
    {"id": "yinyang", "name": "太极对话", "icon": "☯️", "desc": "深褐+琥珀/青绿、思辨感"},
    {"id": "classical", "name": "古典殿堂", "icon": "🏛️", "desc": "暖灰大理石+金色、庄严感"},
    {"id": "adventure", "name": "冒险旅程", "icon": "🧭", "desc": "暖白+多彩色、故事感"},
    {"id": "lab", "name": "实验室", "icon": "🔬", "desc": "深蓝+霓虹青/绿、科学感"},
    {"id": "detective", "name": "案件侦探", "icon": "🕵️", "desc": "软木+琥珀、推理感"},
    {"id": "ergonomic", "name": "人体工学", "icon": "🧑‍🔬", "desc": "浅灰+青色、干净柔和"},
    {"id": "toolbox", "name": "创意工具箱", "icon": "🧰", "desc": "深木+金色、策略卡牌感"},
    {"id": "blueprint", "name": "工程蓝图", "icon": "📐", "desc": "深蓝+方格线、精密工程感"},
    {"id": "workshop", "name": "创客工坊", "icon": "🔧", "desc": "木色+橙黄、手工创客感"},
    {"id": "stage", "name": "发布会", "icon": "🎤", "desc": "深色+金色聚光、展示感"},
    {"id": "construction", "name": "工程现场", "icon": "🏗️", "desc": "深褐+钢蓝网格、粗犷感"},
    {"id": "factory", "name": "流水线车间", "icon": "⚙️", "desc": "浅灰+工业蓝、实用简明"},
    {"id": "network", "name": "网络拓扑", "icon": "🌐", "desc": "深蓝+青/紫、科技连接感"},
    {"id": "cockpit", "name": "仪表控制舱", "icon": "🎛️", "desc": "深灰+LED指示灯、控制感"},
]

QUIZ_THEMES = [
    {"id": "space", "name": "星际太空", "icon": "🚀", "desc": "深色+霓虹、玻璃态、动态星空"},
    {"id": "forest", "name": "知识森林", "icon": "🌿", "desc": "浅绿+白色、柔和亲切"},
    {"id": "blueprint", "name": "工业蓝图", "icon": "🔧", "desc": "深蓝+黄铜、精密机械感"},
    {"id": "memphis", "name": "孟菲斯", "icon": "🎨", "desc": "米白+高饱和几何、活泼明亮"},
    {"id": "popart", "name": "波普漫画", "icon": "💥", "desc": "粗边框+网点、高饱和色"},
    {"id": "vaporwave", "name": "蒸汽波", "icon": "🌅", "desc": "紫渐变+霓虹、复古80s"},
    {"id": "classroom", "name": "未来教室", "icon": "📚", "desc": "玻璃拟态、柔和圆角"},
    {"id": "arena", "name": "竞技场", "icon": "🏆", "desc": "深色+金色、游戏化UI"},
    {"id": "terminal", "name": "赛博终端", "icon": "💻", "desc": "黑底绿字、CRT扫描线"},
    {"id": "minimal", "name": "极简", "icon": "○", "desc": "黑白灰、大留白、细线"},
    {"id": "pixel", "name": "像素风", "icon": "🎮", "desc": "深色+像素块、复古8-Bit"},
    {"id": "nature", "name": "森系", "icon": "🌳", "desc": "暖米+叶绿、柔和自然"},
    {"id": "sketch", "name": "速写风", "icon": "✏️", "desc": "纸张+手写、炭笔线条"},
    {"id": "woodworking", "name": "木工坊", "icon": "🪚", "desc": "木色暖调、仿古卡片"},
    {"id": "launch", "name": "发布会", "icon": "🎤", "desc": "深色+金色聚光、展示感"},
    {"id": "eng blueprint", "name": "工程蓝图", "icon": "📐", "desc": "蓝底白线网格、等宽字体"},
    {"id": "flowchart", "name": "流程图风", "icon": "🔷", "desc": "浅灰+绿色、简洁现代"},
    {"id": "circuit", "name": "电路板风", "icon": "⚡", "desc": "深色+绿色电路、科技硬核"},
    {"id": "dashboard", "name": "仪表盘风", "icon": "📊", "desc": "深色+多色、仪表元素"},
    {"id": "techblue", "name": "科技蓝", "icon": "🔵", "desc": "浅蓝+白色、科技现代"},
]


PRACTICE_THEMES = [
    {"id": "dark-tech", "name": "科技深色", "icon": "🌌", "desc": "深蓝渐变+毛玻璃卡片+Chart.js"},
    {"id": "white-card", "name": "白底卡片", "icon": "📋", "desc": "浅灰渐变+白色卡片+深蓝header"},
    {"id": "cyber-neon", "name": "赛博霓虹", "icon": "💠", "desc": "深色背景+青色发光+科技边框"},
    {"id": "purple-grad", "name": "紫色渐变", "icon": "🔮", "desc": "紫蓝渐变+白色圆角+柔和阴影"},
    {"id": "ai-smart", "name": "AI 智能", "icon": "🤖", "desc": "浅灰渐变+紫蓝header+公式支持"},
    {"id": "green-forest", "name": "森林绿意", "icon": "🌲", "desc": "深绿渐变+暖白卡片+自然柔和阴影"},
    {"id": "ocean-blue", "name": "海洋蓝调", "icon": "🌊", "desc": "蓝青渐变+波浪纹理+清爽透明卡片"},
    {"id": "sunset-warm", "name": "日落暖阳", "icon": "🌅", "desc": "橙红渐变+暖白底色+圆润柔和卡片"},
    {"id": "minimal-paper", "name": "极简白纸", "icon": "📄", "desc": "纯白底色+极细描边+无彩色强调"},
    {"id": "galaxy-night", "name": "星河夜幕", "icon": "🌃", "desc": "深紫星空+发光星星粒子+半透明卡片"},
]


CUSTOM_THEMES = [
    {"id": "cyberpunk", "name": "赛博朋克 2077", "icon": "💀", "desc": "Canvas粒子网络+霓虹渐变+扫描线"},
    {"id": "glassmorphism", "name": "玻璃拟态", "icon": "🪟", "desc": "backdrop-filter毛玻璃+浮动光晕"},
    {"id": "synthwave", "name": "合成波日落", "icon": "🌅", "desc": "Canvas透视网格+日落放射线"},
    {"id": "dark-academia", "name": "暗黑学院", "icon": "📜", "desc": "SVG噪点纹理+衬线排版+dropcap"},
    {"id": "cosmic-nebula", "name": "宇宙星云", "icon": "🌌", "desc": "闪烁星系粒子+星云漂移+鼠标视差"},
    {"id": "botanic", "name": "植物自然", "icon": "🌿", "desc": "SVG有机曲线+植物柔和色系"},
    {"id": "minimal-zen", "name": "极简禅意", "icon": "☯️", "desc": "Enso禅圆+极致留白+侘寂美学"},
    {"id": "neo-tokyo", "name": "新东京", "icon": "🏙️", "desc": "CSS生成建筑群+霓虹色块风格"},
    {"id": "luxury-gold", "name": "奢华金", "icon": "👑", "desc": "暗金配色+噪点纹理+金色呼吸光晕"},
    {"id": "digital-brutalist", "name": "数字粗野", "icon": "🏗️", "desc": "粗野边框+重型字体+裸露网格"},
]


def get_themes_for_type(prompt_type: str) -> list[dict[str, Any]]:
    """获取指定类型可选的主题列表"""
    if prompt_type == "animation":
        return ANIMATION_THEMES
    elif prompt_type == "quiz":
        return QUIZ_THEMES
    elif prompt_type == "practice":
        return PRACTICE_THEMES
    elif prompt_type == "custom":
        return CUSTOM_THEMES
    else:
        return []


def _prompt_format(template: str, **kwargs) -> str:
    """安全替换模板中的 {key} 占位符，忽略 CSS 中的 {--var} 等非标准花括号"""
    import re
    def _replacer(m):
        key = m.group(1)
        return str(kwargs.get(key, m.group(0)))
    # 只匹配 {word_chars} 模式的占位符，{--bg} 或 {:root} 等不会被匹配
    return re.sub(r'\{(\w+)\}', _replacer, template)


def build_html_prompt(prompt_type: str, topic: str = "",
                       rag_context: str = "", subject: str = "",
                       grade: str = "", custom_prompt: str = "",
                       theme: str = "", real_questions: list[dict[str, Any]] | None = None) -> str:
    """根据类型构建完整的 AI Prompt

    Args:
        theme: 可选的主题 ID，为空则让 AI 自行选择
        real_questions: 从题库检索到的真实题目列表
    """
    subject_info = ""
    if subject:
        subject_info += f"学科：{subject}\n"
    if grade:
        subject_info += f"年级：{grade}\n"
    if not subject_info:
        subject_info = "通用"

    # 添加主题选择指令
    theme_instruction = ""
    if theme:
        all_themes = ANIMATION_THEMES + QUIZ_THEMES + PRACTICE_THEMES + CUSTOM_THEMES
        theme_name = theme
        for t in all_themes:
            if t["id"] == theme:
                theme_name = t["name"]
                break
        theme_instruction = f"\n【主题要求】请使用「{theme_name}」风格进行设计。严格遵循该主题的 CSS 变量定义、配色方案和视觉特征。\n"

    # 添加真实题目数据（如果有）
    questions_block = ""
    if real_questions and prompt_type in ("quiz", "practice"):
        import json
        q_list = []
        for idx, q in enumerate(real_questions, 1):
            q_entry = {
                "id": idx,
                "type": q.get("type", "single"),
                "question": q.get("question_text", ""),
                "options": q.get("options", {}),
                "answer": q.get("correct_answer", ""),
                "explanation": q.get("explanation", ""),
                "knowledge_point": q.get("knowledge_points", ""),
                "difficulty": q.get("difficulty", "medium"),
            }
            svg = q.get("svg_content", "")
            if svg:
                q_entry["svg_code"] = svg
            q_list.append(q_entry)

        questions_block = f"""
## ◈ 题库提供的真实题目（共 {len(real_questions)} 道）
以下题目来自系统题库，请**直接使用**这些题目嵌入 HTML 中，不要修改题目文本、选项、答案和解析。
如果题目包含 svg_code（SVG 配图），请将其渲染在题目旁边。
如果题目数量不够，你可以额外补充题目，但必须保持同样的数据格式。

```json
{json.dumps(q_list, ensure_ascii=False, indent=2)}
```

**重要**：请将这些真实题目完整地嵌入到 HTML 的 JavaScript 数据中（QUESTION_BANK 或 questions 变量）。
"""

    if prompt_type == "animation":
        prompt = _prompt_format(
            ANIMATION_HTML_PROMPT,
            topic=topic, subject_info=subject_info, rag_context=rag_context,
        )
    elif prompt_type == "quiz":
        prompt = _prompt_format(
            QUIZ_HTML_PROMPT,
            topic=topic, subject_info=subject_info, rag_context=rag_context,
        )
    elif prompt_type == "practice":
        prompt = _prompt_format(
            PRACTICE_HTML_PROMPT,
            topic=topic, subject_info=subject_info, rag_context=rag_context,
        )
    elif prompt_type == "custom":
        prompt = _prompt_format(
            CUSTOM_HTML_PROMPT,
            custom_prompt=custom_prompt, subject_info=subject_info,
        )
    else:
        raise ValueError(f"不支持的 HTML 类型: {prompt_type}")

    if questions_block:
        prompt += questions_block
    if theme_instruction:
        prompt += theme_instruction

    return prompt
