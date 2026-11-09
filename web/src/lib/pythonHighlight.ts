/**
 * Code Sheet 用的轻量 Python 高亮：纯函数、零依赖、构建期打进 bundle。
 *
 * 刻意不引入 Monaco / shiki / highlight.js——只读展示二十几行案例代码，
 * 一个大型运行时高亮器的体积抵得上整个 playground 前端（首屏纪律见
 * PLAYGROUND_V2.md）。词法只求「案例代码读起来舒服」，不求覆盖整门语言：
 * 注释 / 字符串（含 f-string 前缀）/ 数字 / 关键字 / 其余原样。
 */

export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'plain'

export interface PyToken {
  kind: TokenKind
  text: string
}

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])

// Comments and quoted strings take precedence; triple-quoted strings carry across lines.
const TOKEN_RE = /(#.*$)|([rRbBuUfF]{0,2}(?:"""|'''))|([rRbBuUfF]{0,2}(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b[A-Za-z_]\w*\b)/g
type TripleQuote = '"""' | "'''"

function closingQuote(line: string, from: number, quote: TripleQuote): number {
  let at = line.indexOf(quote, from)
  while (at !== -1) {
    let slashes = 0
    for (let i = at - 1; i >= 0 && line[i] === '\\'; i--) slashes++
    if (slashes % 2 === 0) return at
    at = line.indexOf(quote, at + 3)
  }
  return -1
}

function tokenizeLine(line: string, current: TripleQuote | null): { tokens: PyToken[]; quote: TripleQuote | null } {
  const out: PyToken[] = []
  let last = 0
  if (current) {
    const end = closingQuote(line, 0, current)
    if (end < 0) return { tokens: [{ kind: 'string', text: line }], quote: current }
    last = end + 3
    out.push({ kind: 'string', text: line.slice(0, last) })
    current = null
  }
  TOKEN_RE.lastIndex = 0
  TOKEN_RE.lastIndex = last
  for (let m = TOKEN_RE.exec(line); m; m = TOKEN_RE.exec(line)) {
    if (m.index > last) out.push({ kind: 'plain', text: line.slice(last, m.index) })
    const [, comment, triple, str, num, word] = m
    if (comment != null) out.push({ kind: 'comment', text: comment })
    else if (triple != null) {
      const quote = triple.slice(-3) as TripleQuote
      const end = closingQuote(line, m.index + triple.length, quote)
      if (end < 0) { out.push({ kind: 'string', text: line.slice(m.index) }); return { tokens: out, quote } }
      last = end + 3
      out.push({ kind: 'string', text: line.slice(m.index, last) })
      TOKEN_RE.lastIndex = last
      continue
    }
    else if (str != null) out.push({ kind: 'string', text: str })
    else if (num != null) out.push({ kind: 'number', text: num })
    else out.push({ kind: KEYWORDS.has(word!) ? 'keyword' : 'plain', text: word! })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ kind: 'plain', text: line.slice(last) })
  return { tokens: out, quote: null }
}

/** Tokenize an independent line; full documents should use tokenizePython. */
export function tokenizePythonLine(line: string): PyToken[] {
  return tokenizeLine(line, null).tokens
}

/** 整段源码 → 每行一组 token（渲染方配行号用）。 */
export function tokenizePython(source: string): PyToken[][] {
  let quote: TripleQuote | null = null
  return source.replace(/\n$/, '').split('\n').map((line) => {
    const result = tokenizeLine(line, quote)
    quote = result.quote
    return result.tokens
  })
}
