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
// 6. Under hooks/, no function holds `$` together with a hook's event (its second parameter, followed through the
//    file's functions it is passed to, casts included) in one closure: no closure in a hook, and no closure in a
//    function of the file taking `$`, names both. The directory reports such a function at each call passing it `$`
//    (0.6.103 and 0.6.108: flowToolsIoOf($, c, e) in runFlowTool, whose closures held `$` and the relayed call `e`;
//    it lists at most three lines). Pass the event, or the fields needed, to the closure as an argument instead.
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
  if (registers) bundled(sf, say)
}

// Check 6. Top-level functions by name, the parameters that receive a hook's event, then each closure naming both.
function bundled(sf, say) {
  const isFn = n => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
  const pname = p => ts.isIdentifier(p.name) ? p.name.text : undefined
  const top = new Map()
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && s.body) top.set(s.name.text, s)
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) top.set(d.name.text, d.initializer)
      }
    }
  }
  // An event holder is a function and one of its parameter names; a hook's second parameter starts it.
  const held = new Map()
  const hold = (fn, name) => {
    if (name === undefined) return false
    const s = held.get(fn) ?? new Set()
    if (s.has(name)) return false
    held.set(fn, s.add(name))
    return true
  }
  const hooks = []
  const findHooks = n => {
    if (isFn(n) && isHook(n)) { hooks.push(n); if (n.parameters[1]) hold(n, pname(n.parameters[1])) }
    ts.forEachChild(n, findHooks)
  }
  findHooks(sf)
  // The function whose parameter an identifier at n names, innermost first.
  const ownerOf = (n, name) => {
    for (let p = n.parent; p; p = p.parent) if (isFn(p) && p.parameters.some(q => pname(q) === name)) return p
    return undefined
  }
  const unwrap = a => {
    while (ts.isAsExpression(a) || ts.isParenthesizedExpression(a) || ts.isNonNullExpression(a) || ts.isTypeAssertionExpression(a) || ts.isSatisfiesExpression(a)) a = a.expression
    return a
  }
  const isHeld = (n, a) => {
    a = unwrap(a)
    if (ts.isIdentifier(a)) { const o = ownerOf(n, a.text); return o !== undefined && (held.get(o)?.has(a.text) ?? false) }
    // A copy of the event is the event: { ...e } or { e }.
    if (ts.isObjectLiteralExpression(a)) return a.properties.some(p => (ts.isSpreadAssignment(p) && isHeld(n, p.expression)) || (ts.isShorthandPropertyAssignment(p) && isHeld(n, p.name)))
    return false
  }
  for (let grew = true; grew;) {
    grew = false
    const flow = n => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && top.has(n.expression.text)) {
        const callee = top.get(n.expression.text)
        n.arguments.forEach((a, i) => { if (callee.parameters[i] && isHeld(n, a) && hold(callee, pname(callee.parameters[i]))) grew = true })
      }
      ts.forEachChild(n, flow)
    }
    flow(sf)
  }
  // Names a nested function reads from outside itself.
  const names = fn => {
    const own = new Set(fn.parameters.map(pname))
    const out = new Set()
    const z = k => {
      if (ts.isIdentifier(k) && !own.has(k.text) && !(ts.isPropertyAccessExpression(k.parent) && k.parent.name === k) &&
          !(ts.isPropertyAssignment(k.parent) && k.parent.name === k)) out.add(k.text)
      ts.forEachChild(k, z)
    }
    z(fn.body)
    return out
  }
  const bundles = (fn, events) => {
    const hit = []
    const w = m => {
      if (isFn(m)) { const r = names(m); if (r.has('$') && events.some(e => r.has(e))) hit.push(m) }
      ts.forEachChild(m, w)
    }
    ts.forEachChild(fn.body, w)
    return hit
  }
  const sites = new Map()
  const findSites = n => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.some(a => ts.isIdentifier(a) && a.text === '$')) {
      const l = sites.get(n.expression.text) ?? []
      sites.set(n.expression.text, [...l, n])
    }
    ts.forEachChild(n, findSites)
  }
  findSites(sf)
  for (const h of hooks) {
    if (!h.parameters.some(p => pname(p) === '$')) continue
    for (const m of bundles(h, [...(held.get(h) ?? [])])) say(m, "a closure in a hook holds $ and the hook's event: pass the event to it as an argument")
  }
  for (const [name, fn] of top) {
    if (!fn.parameters.some(p => pname(p) === '$') || !held.has(fn)) continue
    const hit = bundles(fn, [...held.get(fn)])
    if (hit.length === 0) continue
    const why = `${name} holds $ and a hook's event (${[...held.get(fn)].join(', ')}) in one closure: pass the event to that closure as an argument`
    const at = sites.get(name) ?? []
    for (const n of at.length > 0 ? at : hit) say(n, why)
  }
}

if (findings.length > 0) {
  console.error(`plain-names: ${findings.length} finding(s) the plugin directory flags (MOD_CAPABILITY_USE_NOT_PLAIN, MOD_PERMISSION_ANSWER_UNREAD):`)
  for (const f of findings) console.error(`  ${f}`)
  process.exit(1)
}
