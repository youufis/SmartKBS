/**
 * FormulaRenderer — LaTeX 公式渲染组件
 *
 * 基于 react-markdown + remark-math + rehype-katex
 * 支持：
 * - $...$ 行内公式，如 $E=mc^2$
 * - $$...$$ 独立公式块，如 $$\sum_{i=1}^n i$$
 * - \ce{...} 化学式（mhchem），如 $\ce{H2O}$
 * - 与现有 Markdown (GFM) 渲染完全兼容
 *
 * 另外做了两件对 AI 输出很关键的事（见 normalizeMath）：
 * - 把同一行里写的 $$公式$$ 拆成独立公式块（remark-math 只认成行的 $$，
 *   不拆的话「递推关系： $$n! = n\\times(n-1)!$$」会原样显示成文本）；
 * - 把 \\(\\) / \\[\\] 这种 LaTeX 定界符换成 $ / $$；
 * - 还原被 JSON 转义吃掉的 LaTeX 命令（\( \frac 解出来是"换页符 + rac"，公式段
 *   定界符同时失配，整段退化成纯文本 —— 存量题目里的乱码公式靠这一步救回）。
 */
import React from 'react'
import katex from 'katex'
// mhchem 是 KaTeX 的独立扩展：不挂它，化学式 \ce{2H2 + O2 -> 2H2O}、\rightleftharpoons
// 会按未知命令渲染成红色原文。必须紧跟 katex 的 import（它按全局注册扩展）。
import 'katex/contrib/mhchem'
import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { Components } from 'react-markdown'
import type { PluggableList } from 'unified'

/**
 * AI 把 LaTeX 写进 JSON 字符串时，反斜杠的数量几乎从来不对，落库后就是用户看到的
 * 「公式解析不全面」—— 同一道解析里一半公式正常、一半显示成 `rac{2}{2}`、`imes`、
 * 或换行后孤零零一个斜体 `ge 2`。两种损坏形态：
 * 1. 单反斜杠被 JSON 吃掉：`\frac` 里的 `\f` 本身是合法 JSON 转义（换页符），
 *    json.loads 不报错，直接解成 FF+"rac"；同理 \times→TAB+imes、\bar→BS+ar、
 *    \rightarrow→CR+ightarrow、\neq→LF+eq。只有首字母 b/f/n/r/t 中招，
 *    \geq/\infty/\le 反而完好 —— 这正是「有的正常、有的乱码」的原因。
 * 2. 反斜杠叠多了：提示词要求「JSON 里多叠一层」，模型有时叠两层，解出来 `\\ge`，
 *    KaTeX 把 `\\` 当换行命令，公式在中间断行、命令名掉到下一行。
 *
 * 新数据后端已在解析时修好（backend/math_text.repair_math_text，题目入口统一调用）。
 * 这里兜住修复上线前入库的存量，以及不走题目解析链路的来源（聊天等）。命令白名单
 * 与那份实现同源，改动请同步两边。
 */
const CTRL_FIRST: Record<string, string> = { '\b': 'b', '\t': 't', '\n': 'n', '\f': 'f', '\r': 'r' }
const CTRL_CHARS = Object.keys(CTRL_FIRST)
const LATEX_CMDS = new Set<string>([
  'aa', 'AA', 'above', 'acute', 'alef', 'alefsym', 'aleph', 'allowbreak',
  'alpha', 'Alpha', 'amalg', 'And', 'angl', 'angle', 'angln', 'approx',
  'approxcolon', 'approxcoloncolon', 'approxeq', 'arccos', 'arcctg', 'arcsin', 'arctan', 'arctg',
  'arg', 'argmax', 'argmin', 'ast', 'asymp', 'atop', 'backepsilon', 'backprime',
  'backsim', 'backsimeq', 'backslash', 'bar', 'barwedge', 'Bbb', 'Bbbk', 'bcancel',
  'because', 'begin', 'begingroup', 'beta', 'Beta', 'beth', 'between', 'bf',
  'bgroup', 'big', 'Big', 'bigcap', 'bigcirc', 'bigcup', 'bigg', 'Bigg',
  'biggl', 'Biggl', 'Biggm', 'biggm', 'biggr', 'Biggr', 'bigl', 'Bigl',
  'Bigm', 'bigm', 'bigodot', 'bigoplus', 'bigotimes', 'Bigr', 'bigr', 'bigsqcup',
  'bigstar', 'bigtriangledown', 'bigtriangleup', 'biguplus', 'bigvee', 'bigwedge', 'binom', 'blacklozenge',
  'blacksquare', 'blacktriangle', 'blacktriangledown', 'blacktriangleleft', 'blacktriangleright', 'blue', 'blueA', 'blueB',
  'blueC', 'blueD', 'blueE', 'bm', 'bmod', 'bold', 'boldsymbol', 'bot',
  'bowtie', 'Box', 'boxdot', 'boxed', 'boxminus', 'boxplus', 'boxtimes', 'Bra',
  'bra', 'bra@ket', 'bra@set', 'brace', 'brack', 'braket', 'Braket', 'breve',
  'bull', 'bullet', 'Bumpeq', 'bumpeq', 'cal', 'cancel', 'cap', 'Cap',
  'cdot', 'cdotp', 'cdots', 'ce', 'centerdot', 'cfrac', 'ch', 'char',
  'check', 'checkmark', 'chi', 'Chi', 'choose', 'circ', 'circeq', 'circlearrowleft',
  'circlearrowright', 'circledast', 'circledcirc', 'circleddash', 'circledR', 'circledS', 'clap', 'clubs',
  'clubsuit', 'cnums', 'colon', 'Colonapprox', 'colonapprox', 'coloncolon', 'coloncolonapprox', 'coloncolonequals',
  'coloncolonminus', 'coloncolonsim', 'Coloneq', 'coloneq', 'Coloneqq', 'coloneqq', 'colonequals', 'colonminus',
  'Colonsim', 'colonsim', 'color', 'colorbox', 'complement', 'Complex', 'cong', 'coprod',
  'copyright', 'cos', 'cosec', 'cosh', 'cot', 'cotg', 'coth', 'csc',
  'ctg', 'cth', 'cup', 'Cup', 'curlyeqprec', 'curlyeqsucc', 'curlyvee', 'curlywedge',
  'curvearrowleft', 'curvearrowright', 'dag', 'Dagger', 'dagger', 'daleth', 'darr', 'Darr',
  'dArr', 'dashleftarrow', 'dashrightarrow', 'dashv', 'dbinom', 'dblcolon', 'ddag', 'ddagger',
  'ddddot', 'dddot', 'ddot', 'ddots', 'def', 'deg', 'degree', 'delta',
  'Delta', 'det', 'dfrac', 'diagdown', 'diagup', 'diamond', 'Diamond', 'diamonds',
  'diamondsuit', 'digamma', 'dim', 'displaystyle', 'div', 'divideontimes', 'dot', 'doteq',
  'Doteq', 'doteqdot', 'dotplus', 'dots', 'dotsb', 'DOTSB', 'dotsc', 'dotsi',
  'DOTSI', 'dotsm', 'dotso', 'DOTSX', 'dotsx', 'doublebarwedge', 'doublecap', 'doublecup',
  'downarrow', 'Downarrow', 'downdownarrows', 'downharpoonleft', 'downharpoonright', 'edef', 'egroup', 'ell',
  'emph', 'empty', 'emptyset', 'end', 'endgroup', 'enskip', 'enspace', 'Epsilon',
  'epsilon', 'eqcirc', 'Eqcolon', 'eqcolon', 'eqqcolon', 'Eqqcolon', 'eqsim', 'eqslantgtr',
  'eqslantless', 'equalscolon', 'equalscoloncolon', 'equiv', 'errmessage', 'Eta', 'eta', 'eth',
  'exist', 'exists', 'exp', 'expandafter', 'fallingdotseq', 'fbox', 'fcolorbox', 'Finv',
  'flat', 'footnotesize', 'forall', 'frac', 'frak', 'frown', 'futurelet', 'Game',
  'Gamma', 'gamma', 'gcd', 'gdef', 'ge', 'genfrac', 'geq', 'geqq',
  'geqslant', 'gets', 'gg', 'ggg', 'gggtr', 'gimel', 'global', 'gnapprox',
  'gneq', 'gneqq', 'gnsim', 'goldA', 'goldB', 'goldC', 'goldD', 'goldE',
  'grave', 'gray', 'grayA', 'grayB', 'grayC', 'grayD', 'grayE', 'grayF',
  'grayG', 'grayH', 'grayI', 'green', 'greenA', 'greenB', 'greenC', 'greenD',
  'greenE', 'gt', 'gtrapprox', 'gtrdot', 'gtreqless', 'gtreqqless', 'gtrless', 'gtrsim',
  'gvertneqq', 'harr', 'Harr', 'hArr', 'hat', 'hbar', 'hbox', 'hdashline',
  'hearts', 'heartsuit', 'hline', 'hom', 'hookleftarrow', 'hookrightarrow', 'hphantom', 'href',
  'hskip', 'hslash', 'hspace', 'html@mathml', 'htmlClass', 'htmlData', 'htmlId', 'htmlStyle',
  'Huge', 'huge', 'iff', 'iiint', 'iint', 'Im', 'image', 'imageof',
  'imath', 'impliedby', 'implies', 'in', 'includegraphics', 'inf', 'infin', 'infty',
  'injlim', 'int', 'intercal', 'intop', 'Iota', 'iota', 'isin', 'it',
  'jmath', 'Join', 'kaBlue', 'kaGreen', 'kappa', 'Kappa', 'KaTeX', 'ker',
  'kern', 'ket', 'Ket', 'Lambda', 'lambda', 'land', 'lang', 'langle',
  'Large', 'large', 'LARGE', 'larr', 'Larr', 'lArr', 'LaTeX', 'lbrace',
  'lBrace', 'lbrack', 'lceil', 'ldotp', 'ldots', 'le', 'leadsto', 'left',
  'Leftarrow', 'leftarrow', 'leftarrowtail', 'leftharpoondown', 'leftharpoonup', 'leftleftarrows', 'Leftrightarrow', 'leftrightarrow',
  'leftrightarrows', 'leftrightharpoons', 'leftrightsquigarrow', 'leftthreetimes', 'leq', 'leqq', 'leqslant', 'lessapprox',
  'lessdot', 'lesseqgtr', 'lesseqqgtr', 'lessgtr', 'lesssim', 'let', 'lfloor', 'lg',
  'lgroup', 'lhd', 'lim', 'liminf', 'limits', 'limsup', 'll', 'llap',
  'llbracket', 'llcorner', 'Lleftarrow', 'lll', 'llless', 'lmoustache', 'ln', 'lnapprox',
  'lneq', 'lneqq', 'lnot', 'lnsim', 'log', 'long', 'longleftarrow', 'Longleftarrow',
  'Longleftrightarrow', 'longleftrightarrow', 'longmapsto', 'longrightarrow', 'Longrightarrow', 'looparrowleft', 'looparrowright', 'lor',
  'lozenge', 'lparen', 'lq', 'Lrarr', 'lrarr', 'lrArr', 'lrcorner', 'Lsh',
  'lt', 'ltimes', 'lVert', 'lvert', 'lvertneqq', 'maltese', 'mapsto', 'maroonA',
  'maroonB', 'maroonC', 'maroonD', 'maroonE', 'mathbb', 'mathbf', 'mathbin', 'mathcal',
  'mathchoice', 'mathclap', 'mathclose', 'mathellipsis', 'mathfrak', 'mathinner', 'mathit', 'mathllap',
  'mathnormal', 'mathop', 'mathopen', 'mathord', 'mathpunct', 'mathrel', 'mathring', 'mathrlap',
  'mathrm', 'mathscr', 'mathsf', 'mathsfit', 'mathsterling', 'mathstrut', 'mathtt', 'max',
  'measuredangle', 'medspace', 'message', 'mho', 'mid', 'middle', 'min', 'mintA',
  'mintB', 'mintC', 'minuscolon', 'minuscoloncolon', 'minuso', 'mkern', 'mod', 'models',
  'mp', 'mskip', 'mu', 'Mu', 'multimap', 'nabla', 'natnums', 'natural',
  'ncong', 'ne', 'nearrow', 'neg', 'negmedspace', 'negthickspace', 'negthinspace', 'neq',
  'newcommand', 'newline', 'nexists', 'ngeq', 'ngeqq', 'ngeqslant', 'ngtr', 'ni',
  'nleftarrow', 'nLeftarrow', 'nLeftrightarrow', 'nleftrightarrow', 'nleq', 'nleqq', 'nleqslant', 'nless',
  'nmid', 'nobreak', 'nobreakspace', 'noexpand', 'nolimits', 'nonumber', 'normalsize', 'not',
  'notag', 'notin', 'notni', 'nparallel', 'nprec', 'npreceq', 'nrightarrow', 'nRightarrow',
  'nshortmid', 'nshortparallel', 'nsim', 'nsubseteq', 'nsubseteqq', 'nsucc', 'nsucceq', 'nsupseteq',
  'nsupseteqq', 'ntriangleleft', 'ntrianglelefteq', 'ntriangleright', 'ntrianglerighteq', 'Nu', 'nu', 'nvDash',
  'nVdash', 'nvdash', 'nVDash', 'nwarrow', 'odot', 'oiiint', 'oiint', 'oint',
  'Omega', 'omega', 'Omicron', 'omicron', 'ominus', 'operatorname', 'operatorname*', 'operatorname@',
  'operatornamewithlimits', 'oplus', 'orange', 'ordinarycolon', 'origof', 'oslash', 'otimes', 'over',
  'overbrace', 'overbracket', 'overgroup', 'overleftarrow', 'overleftharpoon', 'overleftrightarrow', 'overline', 'overlinesegment',
  'Overrightarrow', 'overrightarrow', 'overrightharpoon', 'overset', 'owns', 'parallel', 'partial', 'perp',
  'phantom', 'phase', 'phi', 'Phi', 'pi', 'Pi', 'pink', 'pitchfork',
  'plim', 'plusmn', 'pm', 'pmb', 'pmod', 'pod', 'pounds', 'Pr',
  'prec', 'precapprox', 'preccurlyeq', 'preceq', 'precnapprox', 'precneqq', 'precnsim', 'precsim',
  'prime', 'prod', 'projlim', 'propto', 'providecommand', 'providecommand*', 'Psi', 'psi',
  'pu', 'purple', 'purpleA', 'purpleB', 'purpleC', 'purpleD', 'purpleE', 'qquad',
  'quad', 'raisebox', 'rang', 'rangle', 'Rarr', 'rarr', 'rArr', 'ratio',
  'rBrace', 'rbrace', 'rbrack', 'rceil', 'Re', 'real', 'reals', 'Reals',
  'red', 'redA', 'redB', 'redC', 'redD', 'redE', 'relax', 'renewcommand',
  'restriction', 'rfloor', 'rgroup', 'rhd', 'rho', 'Rho', 'right', 'rightarrow',
  'Rightarrow', 'rightarrowtail', 'rightharpoondown', 'rightharpoonup', 'rightleftarrows', 'rightleftharpoons', 'rightrightarrows', 'rightsquigarrow',
  'rightthreetimes', 'risingdotseq', 'rlap', 'rm', 'rmoustache', 'rparen', 'rq', 'rrbracket',
  'Rrightarrow', 'Rsh', 'rtimes', 'rule', 'rVert', 'rvert', 'scriptscriptstyle', 'scriptsize',
  'scriptstyle', 'sdot', 'searrow', 'sec', 'sect', 'Set', 'set', 'setminus',
  'sf', 'sh', 'sharp', 'shortmid', 'shortparallel', 'show', 'Sigma', 'sigma',
  'sim', 'simcolon', 'simcoloncolon', 'simeq', 'sin', 'sinh', 'sixptsize', 'small',
  'smallfrown', 'smallint', 'smallsetminus', 'smallsmile', 'smash', 'smile', 'sout', 'space',
  'spades', 'spadesuit', 'sphericalangle', 'sqcap', 'sqcup', 'sqrt', 'sqsubset', 'sqsubseteq',
  'sqsupset', 'sqsupseteq', 'square', 'stackrel', 'star', 'sub', 'sube', 'Subset',
  'subset', 'subseteq', 'subseteqq', 'subsetneq', 'subsetneqq', 'substack', 'succ', 'succapprox',
  'succcurlyeq', 'succeq', 'succnapprox', 'succneqq', 'succnsim', 'succsim', 'sum', 'sup',
  'supe', 'supset', 'Supset', 'supseteq', 'supseteqq', 'supsetneq', 'supsetneqq', 'surd',
  'swarrow', 'tag', 'tag@literal', 'tag@paren', 'tan', 'tanh', 'Tau', 'tau',
  'tbinom', 'tealA', 'tealB', 'tealC', 'tealD', 'tealE', 'TeX', 'text',
  'textbf', 'textcircled', 'textcolor', 'textcopyright', 'textit', 'textmd', 'textnormal', 'TextOrMath',
  'textregistered', 'textrm', 'textsf', 'textstyle', 'texttt', 'textup', 'tfrac', 'tg',
  'th', 'therefore', 'theta', 'Theta', 'thetasym', 'thickapprox', 'thicksim', 'thickspace',
  'thinspace', 'tilde', 'times', 'tiny', 'tmspace', 'to', 'top', 'triangle',
  'triangledown', 'triangleleft', 'trianglelefteq', 'triangleq', 'triangleright', 'trianglerighteq', 'tripledash', 'tt',
  'twoheadleftarrow', 'twoheadrightarrow', 'uarr', 'uArr', 'Uarr', 'ulcorner', 'underbar', 'underbrace',
  'underbracket', 'undergroup', 'underleftarrow', 'underleftrightarrow', 'underline', 'underlinesegment', 'underrightarrow', 'underset',
  'unlhd', 'unrhd', 'uparrow', 'Uparrow', 'updownarrow', 'Updownarrow', 'upharpoonleft', 'upharpoonright',
  'uplus', 'Upsilon', 'upsilon', 'upuparrows', 'urcorner', 'url', 'utilde', 'varDelta',
  'varepsilon', 'varGamma', 'varinjlim', 'varkappa', 'varLambda', 'varliminf', 'varlimsup', 'varnothing',
  'varOmega', 'varphi', 'varPhi', 'varPi', 'varpi', 'varprojlim', 'varpropto', 'varPsi',
  'varrho', 'varsigma', 'varSigma', 'varsubsetneq', 'varsubsetneqq', 'varsupsetneq', 'varsupsetneqq', 'vartheta',
  'varTheta', 'vartriangle', 'vartriangleleft', 'vartriangleright', 'varUpsilon', 'varvdots', 'varXi', 'vcentcolon',
  'vcenter', 'Vdash', 'vDash', 'vdash', 'vdots', 'vec', 'vee', 'veebar',
  'verb', 'verb*', 'Vert', 'vert', 'vphantom', 'Vvdash', 'wedge', 'weierp',
  'widecheck', 'widehat', 'widetilde', 'wp', 'wr', 'xcancel', 'xdef', 'xhookleftarrow',
  'xhookrightarrow', 'xi', 'Xi', 'xLeftarrow', 'xleftarrow', 'xleftequilibrium', 'xleftharpoondown', 'xleftharpoonup',
  'xLeftrightarrow', 'xleftrightarrow', 'xleftrightharpoons', 'xlongequal', 'xmapsto', 'xRightarrow', 'xrightarrow', 'xrightequilibrium',
  'xrightharpoondown', 'xrightharpoonup', 'xrightleftarrows', 'xrightleftharpoons', 'xtofrom', 'xtwoheadleftarrow', 'xtwoheadrightarrow', 'yen',
  'zeta', 'Zeta',
])
const MATHISH = new Set('{}^_\\$0123456789'.split(''))
const FENCE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
const TAIL_LETTERS = /^[A-Za-z]+/
const OVER_ESCAPED = /\\{2,}([A-Za-z]+)/g

/** 位置 i 是否处在行首缩进位（到行首只有空白）；ctx 是这段切片前面的字符 */
function isIndent(text: string, i: number, ctx = ''): boolean {
  for (let j = i - 1; j >= -ctx.length; j--) {
    const ch = j >= 0 ? text[j] : ctx[j]
    if (ch === ' ' || ch === '\t') continue
    return ch === '\n'
  }
  return true
}

/** 控制字符 + 尾缀 -> 还原成 `\命令`；还原不了时（公式段内）把裸控制字符丢掉 */
function restoreCtrl(text: string, dropUnknown: boolean, ctx = '', after = ''): string {
  if (!CTRL_CHARS.some((c) => text.includes(c))) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const first = CTRL_FIRST[ch]
    if (first) {
      const m = TAIL_LETTERS.exec(text.slice(i + 1))
      const tail = m ? m[0] : ''
      const cand = tail ? first + tail : ''
      // \n / \r 本身是合法换行：尾缀够长（≥2）且拼出来是命令才还原；
      // 行首缩进位的制表符/换行是排版，不是被吃掉的反斜杠。
      if (tail && LATEX_CMDS.has(cand) &&
          ((ch !== '\n' && ch !== '\r') || tail.length >= 2 || MATHISH.has(text[i + 1 + tail.length] ?? after[0] ?? '')) &&
          !isIndent(text, i, ctx)) {
        out += '\\' + cand
        i += tail.length
        continue
      }
      if (ch === '\r' && text[i + 1] === '\n') continue
      if (dropUnknown && '\b\t\v\f\r'.includes(ch)) continue
    }
    out += ch
  }
  return out
}

/** 公式段正文的 [start, end)：$…$ / $$…$$ / \(…\) / \[…\]；定界符不配对就保守跳过 */
function mathSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const nxt = text[i + 1]
      if (nxt === '(' || nxt === '[') {
        const close = nxt === '(' ? '\\)' : '\\]'
        const j = text.indexOf(close, i + 2)
        if (j < 0) {
          i += 2
          continue
        }
        spans.push([i + 2, j])
        i = j + 2
        continue
      }
      if (nxt === '$') {
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (ch === '$') {
      const two = text.startsWith('$$', i)
      const marker = two ? '$$' : '$'
      const j = text.indexOf(marker, i + marker.length)
      if (j < 0) {
        i += marker.length
        continue
      }
      if (!two && text.slice(i + marker.length, j).includes('\n\n')) {
        i += marker.length
        continue
      }
      spans.push([i + marker.length, j])
      i = j + marker.length
      continue
    }
    i += 1
  }
  return spans
}

/** 一段非代码文本：公式段内还原控制字符 + 折叠多余反斜杠，段外只做保守还原 */
function repairRegion(text: string): string {
  const spans = mathSpans(text)
  if (!spans.length) return restoreCtrl(text, false)
  const pieces: string[] = []
  let pos = 0
  for (const [a, b] of spans) {
    if (a < pos) continue
    pieces.push(restoreCtrl(text.slice(pos, a), false, text.slice(Math.max(0, pos - 2), pos)))
    const body = restoreCtrl(text.slice(a, b), true, text.slice(Math.max(0, a - 2), a), text.slice(b, b + 1))
    pieces.push(body.replace(OVER_ESCAPED, (whole, g) => (LATEX_CMDS.has(String(g)) ? '\\' + g : whole)))
    pos = b
  }
  pieces.push(restoreCtrl(text.slice(pos), false, text.slice(Math.max(0, pos - 2), pos)))
  return pieces.join('')
}

/** 还原被 JSON 转义吃掉的 LaTeX 命令（幂等；正常文本原样返回，代码围栏整段跳过） */
export function repairMathEscapes(src: string): string {
  if (!src) return src
  if (!CTRL_CHARS.some((c) => src.includes(c)) && !/\\{2,}[A-Za-z]/.test(src)) return src
  // 整坨 JSON（options/questions 这类序列化字段）不就地修：里面的 \\div 已经是合法转义，
  // 折成单个反斜杠会让整坨解析失败。要修得先 parse 再逐字段修（与后端同源规则）。
  if ((src[0] === '{' || src[0] === '[') && src.length > 40) {
    try {
      JSON.parse(src)
      return src
    } catch {
      /* 不是合法 JSON，按普通文本继续 */
    }
  }
  return src
    .split(FENCE_SPLIT)
    .map((chunk, i) => (i % 2 ? chunk : repairRegion(chunk)))
    .join('')
}


/**
 * 把 AI 常写的「行内 $$...$$」与 \(\)、\[\] 定界符整理成 remark-math 认得的形式。
 * 代码块内部原样保留，避免把示例代码里的 $$ 也改了。
 */
/**
 * 屏蔽成对的 $$ 定界符后，把**明显是钱/散文**的 $…$ 转义成字面量，别让 remark-math 当公式。
 *
 * ⚠️ 判据只保留"包裹内容里含中文"这一条（2026-10-12 修）：
 *   旧实现还额外按"含数字"转义，结果把**纯数值公式**一起误伤 ——
 *   老师实测：题干 `$1011000$`、选项 `$88$`（进制/数值题）在页面上原样显示成了 `$88$`。
 *   这类"数字在 $ 里"在教学材料里绝大多数就是公式，必须渲染。
 *   而真正的货币/散文写法（价格$5和$6、$1.2 万亿）包裹内容里一定有中文，那条判据已经兜住了。
 *   $x$、$f(x)$、$88$、$1011000$  -> 保留（是公式）
 *   $5和$6、$1.2 万亿             -> 转义（是钱，不是公式）
 */
function maskDollars(text: string): string {
  const MASK = '\u0000'
  const masked = text.replace(/\$\$/g, MASK + MASK)
  const fixed = masked.replace(/\$([^$\n]+)\$/g, (whole, body) => {
    if (/[\\^_{}=]/.test(body)) return whole
    if (/[\u4e00-\u9fff]/.test(body)) return '\\$' + body + '\\$'
    return whole
  })
  return fixed.split(MASK + MASK).join('$$')
}

export function normalizeMath(src: string): string {
  if (!src) return src
  // 先把被 JSON 转义吃掉的 LaTeX 命令还原回来（存量数据兜底，见 repairMathEscapes）
  let text = repairMathEscapes(src).replace(/\r\n/g, '\n')
  // \(\) -> $：旧实现用 [^)] 排除右括号，凡是公式里带 ")"（\(f(0)=3\)、\times(-1)）
  // 就整段匹配不上，公式原样显示成文本 —— 改成非贪婪吃到第一个 \)，跨空行则不动。
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (whole, g) =>
    /\n\s*\n/.test(g) ? whole : '$' + String(g).trim() + '$')
  text = text.replace(/\\\[\s*([\s\S]+?)\s*\\\]/g, (_m, g) => '\n\n$$\n' + g.trim() + '\n$$\n\n')
  // 「价格$5和$6」这类没有 LaTeX 特征的 $…$ 先转义，避免被误判成公式
  text = maskDollars(text)

  const out: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('```') || t.startsWith('~~~')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    // 纯 $$ 分隔行、行内代码、没有 $$、或还在代码块里的，一律不动
    if (inFence || t === '$$' || line.includes('`') || !line.includes('$$')) {
      out.push(line)
      continue
    }
    const parts = line.split('$$')
    if (parts.length < 3) {
      out.push(line)
      continue
    }
    const rebuilt: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i].trim()
      if (!seg) continue
      if (i % 2 === 0) rebuilt.push(seg)
      else rebuilt.push('$$', seg, '$$')
    }
    out.push(rebuilt.join('\n'))
    if (rebuilt.length) out.push('')
  }
  return out.join('\n')
}

/**
 * 把单个换行补成 Markdown 硬换行（行尾两个空格），让原本按 pre-wrap 显示的
 * 纯文本换到 Markdown 渲染后仍保持同样的断行；列表、标题、表格、引用、代码块等
 * 结构化行不动，避免把语法行拆成两段。
 */
export function preserveBreaks(text: string): string {
  if (!text) return text
  const structural = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```|~~~|\*\*\*|---|===)/
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (t.startsWith('```') || t.startsWith('~~~')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) { out.push(line); continue }
    const nextT = (lines[i + 1] ?? '').trim()
    const keepAsIs = !t || t.endsWith('  ') || !nextT || structural.test(t) || structural.test(nextT)
    out.push(keepAsIs ? line : line + '  ')
  }
  return out.join('\n')
}

/**
 * 按行扫描切出 ``` / ~~~ 围栏代码块。
 *
 * 为什么自己切而不交给 react-markdown：行内场景（列表行、选项、表格单元格）不能出现
 * 块级 <pre> —— 它会把 nowrap + ellipsis 的单元格整个撑破，正好毁掉刚做完的行高收紧。
 * 切出来之后，文字段照常行内渲染，代码段单独压成一枚徽标。
 */
export type Segment = { code: boolean; text: string; lines: number }

export function splitFences(src: string): Segment[] {
  if (!src || (!src.includes('```') && !src.includes('~~~'))) {
    return [{ code: false, text: src || '', lines: 0 }]
  }
  const out: Segment[] = []
  let buf: string[] = []
  let fence: string[] | null = null
  const flushText = () => {
    const text = buf.join('\n')
    buf = []
    if (text.trim()) out.push({ code: false, text, lines: 0 })
  }
  for (const line of src.replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim()
    const isFence = t.startsWith('```') || t.startsWith('~~~')
    if (fence) {
      if (isFence && t.slice(0, 3) === fence[0]) {
        // 收尾：丢掉 ```python 那行的语言名，只留代码本体
        const body = fence.slice(1).join('\n')
        out.push({ code: true, text: body, lines: body.split('\n').filter(l => l.trim()).length })
        fence = null
      } else {
        // 保留原始行：Python 的缩进就是语义，只去掉行尾空白
        fence.push(line.replace(/\s+$/, ''))
      }
      continue
    }
    if (isFence) {
      flushText()
      fence = [t.slice(0, 3)]
      continue
    }
    buf.push(line)
  }
  if (fence) {
    // 模型只写了开头没闭合：按代码处理，别把 ``` 原样甩在题干里
    const body = fence.slice(1).join('\n')
    out.push({ code: true, text: body, lines: body.split('\n').filter(l => l.trim()).length })
  }
  flushText()
  return out.length ? out : [{ code: false, text: src, lines: 0 }]
}

/** 行内场景的代码徽标：只报行数，完整内容在 Tooltip 里看（等宽、保留缩进、可滚） */
const CodeChip: React.FC<{ text: string; lines: number }> = ({ text, lines }) => {
  const { t } = useTranslation('common')
  return (
    <Tooltip title={<pre className="formula-code-tip">{text}</pre>} overlayStyle={{ maxWidth: 560 }}>
      <span className="formula-code-chip">
        {'{'}…{'}'} {t('codeChip', { count: Math.max(1, lines) })}
      </span>
    </Tooltip>
  )
}

/**
 * 块级代码与行内代码的渲染。类名自带样式，不再要求调用方额外包一层 .markdown-content
 * —— 之前代码块样式只挂在 .markdown-content pre/code 上，聊天/任务页包了就有底色，
 * 题目那一片没包，于是围栏代码渲染成光秃秃的浏览器默认 <pre>，看着仍像正文。
 */
const codeComponents: Components = {
  // node 是 hast 节点对象，不能跟着 spread 进 DOM
  pre: ({ node, children, ...rest }) => <pre className="formula-code" {...rest}>{children}</pre>,
  code: ({ node, children, ...rest }) => (
    <code className="formula-code-inline" {...rest}>{children}</code>
  ),
}

interface FormulaRendererProps {
  /** Markdown / LaTeX 混合内容 */
  content: string
  /** 行内模式：用于选项等短文本，不渲染 GFM */
  inline?: boolean
  /** 追加或覆盖 react-markdown 的组件渲染（如自定义 code 高亮） */
  components?: Components
  /** 是否启用 GFM（表格、删除线等），默认 true。
   *  原本没挂 remarkGfm 的长文本页传 false：只加公式渲染，不改现有排版 */
  gfm?: boolean
  /** 是否把单个换行保留成硬换行（原 pre-wrap 纯文本改渲染时用） */
  breaks?: boolean
}

/**
 * 下面三组常量必须是模块级：每次 render 新建数组/对象会让 react-markdown 认定
 * "配置变了"，于是把整棵 Markdown AST 连同 KaTeX 重新解析渲染一遍。
 * 试题管理一屏 50 行、每行 1-2 个实例，点一个勾选框就要重解析上百篇文档（实测卡 1 秒）。
 */
const REHYPE_PLUGINS = [rehypeKatex]
const REMARK_PLUGINS_GFM: PluggableList = [remarkGfm, remarkMath]
const REMARK_PLUGINS_MATH: PluggableList = [remarkMath]
/** 行内模式默认只有 img 覆盖，提到模块级供无自定义 components 的调用方共用 */
const INLINE_COMPONENTS: Components = {
  img: ({ src, alt }) => (
    <img src={src} alt={alt || ''} style={{ maxWidth: 120, maxHeight: 80, verticalAlign: 'middle', margin: '0 4px', borderRadius: 4 }} />
  ),
}

/**
 * 会不会让 Markdown / LaTeX 语义生效？命中任意一条就老老实实走完整管线。
 * 判据故意偏保守：宁可少走快路径，也不能让题干渲染结果和以前不一样。
 */
function needsFullPipeline(src: string): boolean {
  if (src.includes('\n')) return true                       // 多行：段落 / 列表 / 硬换行交给 markdown
  if (/[\\`*_~<>|]/.test(src)) return true                 // 转义、代码、强调、原始 HTML、表格分隔
  if (src.includes('$$')) return true                        // 独立公式块
  if (/!\[|\[[^\]]*\]\(|https?:\/\/|www\./.test(src)) return true  // 图片 / 链接 / GFM 自动链接
  if (/^\s*(#{1,6}\s|>|[-+]\s|\d+[.)]\s|=)/.test(src)) return true   // 行首块级标记
  return false
}

const INLINE_MATH = /\$([^$\n]+)\$/g

/**
 * 单行、无块级语法、只含 $...$ 行内公式时，直接逐段 katex.renderToString，
 * 跳过 unified -> remark -> rehype -> katex 整条管线。
 * 返回 null 表示"没有公式"，由调用方按纯文本渲染。
 *
 * 产出的 DOM 与完整管线一致（同样是 <p> 包 <span class="katex">），
 * 所以只在没有自定义 components（调用方可能覆盖 p/img 等）时才启用。
 */
function renderInlineMathSegments(src: string): React.ReactNode[] | null {
  if (!src.includes('$')) return null
  const out: React.ReactNode[] = []
  let last = 0
  let hit = false
  INLINE_MATH.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_MATH.exec(src)) !== null) {
    hit = true
    if (m.index > last) out.push(src.slice(last, m.index))
    if (m[1]) {
      out.push(
        <span
          key={`m-${m.index}`}
          dangerouslySetInnerHTML={{ __html: katex.renderToString(m[1], { throwOnError: false, displayMode: false }) }}
        />,
      )
    }
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < src.length) out.push(src.slice(last))
  return out
}

const FormulaRendererInner: React.FC<FormulaRendererProps> = ({ content, inline = false, components, gfm = true, breaks = false }) => {
  const source = React.useMemo(() => {
    const normalized = normalizeMath(content || '')
    return breaks ? preserveBreaks(normalized) : normalized
  }, [content, breaks])

  // 快路径：题干/选项绝大多数是"单行纯文本"或"单行 + 行内公式"，不值得跑整条 markdown 管线
  if (source && !components && !needsFullPipeline(source)) {
    const segs = renderInlineMathSegments(source)
    if (!segs) return <p>{source}</p>
    return <p>{segs}</p>
  }

  if (!source) return null

  if (inline) {
    // 选项等简短内容：公式 + 图片 + 基本 Markdown
    const inlineComponents: Components = components ? { ...INLINE_COMPONENTS, ...components } : INLINE_COMPONENTS
    const segments = splitFences(source)
    if (!segments.some(seg => seg.code)) {
      return (
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS_GFM} rehypePlugins={REHYPE_PLUGINS} components={inlineComponents}>
          {source}
        </ReactMarkdown>
      )
    }
    // 题干里带代码块时：文字照常行内渲染，代码压成徽标，块级 <pre> 不进单元格
    return (
      <>
        {segments.map((seg, i) => (seg.code
          ? <CodeChip key={`code-${i}`} text={seg.text} lines={seg.lines} />
          : (
            <ReactMarkdown
              key={`text-${i}`}
              remarkPlugins={REMARK_PLUGINS_GFM}
              rehypePlugins={REHYPE_PLUGINS}
              components={inlineComponents}
            >
              {seg.text}
            </ReactMarkdown>
          )))}
      </>
    )
  }

  // 完整模式：GFM（表格、列表、代码块）+ 公式；调用方自带的 components 优先级更高
  const merged: Components = components ? { ...codeComponents, ...components } : codeComponents
  return (
    <ReactMarkdown
      remarkPlugins={gfm ? REMARK_PLUGINS_GFM : REMARK_PLUGINS_MATH}
      rehypePlugins={REHYPE_PLUGINS}
      components={merged}
    >
      {source}
    </ReactMarkdown>
  )
}

/** 包一层 memo：表格翻页 / 勾选任意一行都不该把 50 行的公式重解析一遍 */
const FormulaRenderer = React.memo(FormulaRendererInner)

export default FormulaRenderer
