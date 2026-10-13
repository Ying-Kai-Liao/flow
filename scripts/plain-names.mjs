// Guards the plugin directory's MOD_CAPABILITY_USE_NOT_PLAIN rule, and MOD_PERMISSION_ANSWER_UNREAD for agent.register,
// on the source, which the test sandbox cannot read (it has no fs, and compiled code has lost its types). Run by scripts/typecheck.sh; exits 1 on a finding.
//
// 1. A .tsx/.jsx file writes `h` (the JSX factory) only to call it, and never names anything h or Fragment:
//    no variable, parameter, property or shorthand property.
// 2. Under hooks/, a function taking `$` is a function declaration or an arrow with no return type: the
//    directory reads a typed arrow taking `$` as a hook declared as something else.
// 3. Under hooks/, a file that registers hooks declares nothing else under the names it gives `on` (register's
//    first parameter), `$` or a hook's third parameter (`next`).
// 4. Under hooks/, a call taking `$`, awaited or not, is never parenthesized and then followed by `!`, `?.`, `[...]`
//    or `as`: `(await f($, x))?.y`. Assign it to a const first.
// 5. Under hooks/, `$.agent.register(...)` takes an object literal written in the call, with no spread: the directory
//    (MOD_PERMISSION_ANSWER_UNREAD) can only confirm an agent leaves permission decisions with the user from that.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')
const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.jsx'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const findings = []

const isOnCall = n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'on'
// A hook: the function passed to on(...), or to the .catch(...) chained on it.
const isHook = fn => {
  const call = fn.parent
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(fn)) return false
  if (isOnCall(call)) return true
  const pa = call.expression
  return ts.isPropertyAccessExpression(pa) && pa.name.text === 'catch' && isOnCall(pa.expression)
}

for (const file of files) {
  const jsx = /\.[jt]sx$/.test(file)
  const hooks = file.startsWith('hooks/')
  if (!jsx && !hooks) continue
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const say = (node, why) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
    findings.push(`${file}:${line + 1}: ${why}: ${src.split('\n')[line].trim().slice(0, 120)}`)
  }

  // The names this file gives on, $ and next.
  const reserved = new Set()
  const collect = n => {
    if (isOnCall(n)) {
      const fn = n.arguments[n.arguments.length - 1]
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        for (const i of [0, 2]) { const p = fn.parameters[i]; if (p && ts.isIdentifier(p.name)) reserved.add(p.name.text) }
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'register' && n.initializer && ts.isArrowFunction(n.initializer)) {
      const p = n.initializer.parameters[0]
      if (p && ts.isIdentifier(p.name)) reserved.add(p.name.text)
    }
    ts.forEachChild(n, collect)
  }
  if (hooks) collect(sf)
  const registers = reserved.size > 0
  reserved.delete('_$')

  const visit = n => {
    if (jsx && ts.isIdentifier(n) && (n.text === 'h' || n.text === 'Fragment')) {
      const p = n.parent
      if (!(n.text === 'h' && ts.isCallExpression(p) && p.expression === n)) say(n, `${n.text} names something other than the JSX factory call`)
    }
    if (hooks && ts.isArrowFunction(n) && n.type && n.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === '$')) {
      say(n, 'an arrow taking $ has a return type: make it a function declaration')
    }
    if (registers && (ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n) || ts.isParameter(n)) &&
        n.name && ts.isIdentifier(n.name) && reserved.has(n.name.text)) {
      const fn = ts.isParameter(n) ? n.parent : undefined
      const ok = fn !== undefined && (isHook(fn) || ts.isFunctionDeclaration(fn) ||
        (ts.isArrowFunction(fn) && fn.type === undefined && n.name.text === '$') ||
        (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) && fn.parent.name.text === 'register'))
      if (!ok) say(n, `declares ${n.name.text}, a name this file gives on, $ or a hook's next`)
    }
    if (hooks && ts.isParenthesizedExpression(n)) {
      const p = n.parent
      const what = ts.isNonNullExpression(p) ? '!'
        : (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n
          ? (p.questionDotToken ? '?.' : ts.isElementAccessExpression(p) ? '[...]' : undefined)
          : ts.isAsExpression(p) ? 'as' : undefined
      let inner = n.expression
      if (ts.isAwaitExpression(inner)) inner = inner.expression
      if (what && ts.isCallExpression(inner) && inner.arguments.some(a => ts.isIdentifier(a) && a.text === '$')) {
        say(n, `a call taking $ is wrapped in parentheses and ${what}: assign it to a const first`)
      }
    }
    if (hooks && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'register') {
      const noun = n.expression.expression
      if (ts.isPropertyAccessExpression(noun) && noun.name.text === 'agent' && ts.isIdentifier(noun.expression) && noun.expression.text === '$') {
        const arg = n.arguments[0]
        if (n.arguments.length !== 1 || !ts.isObjectLiteralExpression(arg) || arg.properties.some(ts.isSpreadAssignment)) {
          say(n, '$.agent.register takes something other than an object literal without spread: write the fields in the call')
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

if (findings.length > 0) {
  console.error(`plain-names: ${findings.length} finding(s) the plugin directory flags (MOD_CAPABILITY_USE_NOT_PLAIN, MOD_PERMISSION_ANSWER_UNREAD):`)
  for (const f of findings) console.error(`  ${f}`)
  process.exit(1)
}
