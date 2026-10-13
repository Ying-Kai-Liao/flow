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
// 7. Under hooks/, in a file that registers hooks, $ is followed from each hook into the file's top-level functions
//    it is passed to, transitively, as the directory does (`claude plugin validate` lists `$.agent.list (via agentsOf,
//    ..., flowToolsIoOf, ...)`). In every function reached, a $ use is not wrapped: no `$.noun.method(...)` spread
//    (`[...await $.agent.list()]`), no cast or `!` in its arguments (`$.ui.resolve(ev as never)`), and no call passing
//    $ spread (`...guardIoOf($)`) or read for a member straight off (`sessionIoOf($).updateSessions(...)`; `.then`,
//    `.catch` and `.finally` are fine). Bind the call to a const first. Each such use is reported, and so is each call
//    passing $ to a function that reaches one: the directory reported 0.6.109 at three flowToolsIoOf($, ...) calls,
//    though the shapes sat in agentsOf and paneIoOf. These shapes are the ones the file gained after 0.6.84, the last
//    release the directory passed; that release has none, and it had the other wrapped shapes checks 1-6 allow.
//    0.6.111 removed every shape this check finds and the directory still reported the same three calls, so it does
//    not predict the directory; it stays as a guard on shapes no release has needed.
// 8. Under hooks/, in a file that registers hooks, an io builder (a top-level function taking $ and returning an
//    object literal) is not called from more than one case of a switch when more than 12 of its members use $
//    (directly or by passing it on). A guess calibrated to evidence, not a known rule: the directory reported
//    flowToolsIoOf($, ...) in runFlowTool's switch on 0.6.103 to 0.6.111 (8 cases, 19 members using $) whatever its
//    members looked like, while handoverIoOf, planIoOf and slotsIoOf (one case each) and inboxIoOf (4 cases, 11
//    members) in the same switch were never reported, and 0.6.84, the last release it passed, built each tool's io
//    in its own hook. Give each case its own small io builder holding only what it uses.
// 9. Under hooks/, in a file that registers hooks, in every function $ reaches (followed as in check 7), each
//    `$.noun.method(...)` is a whole statement, a whole `return` value, a whole arrow body or the whole initializer
//    of a `const x =`, awaited or not: never chained (`.then`, `.catch`, `.finally`), in a ternary, `??`, `||`,
//    `&&` or template, an argument of another call (`JSON.parse(await $.fs.read(p))`), under `void`, or assigned to
//    a `let`. A call passing $ is never chained either, and no `const f = ($) => ...` helper takes $: declare it
//    with `function`. Put a fallback in a try/catch and a branch in an `if` in a declared helper. A guess
//    calibrated to evidence, not a known rule: 0.6.112 was reported at the calls reaching releaseIoOf (a ternary
//    of $ calls), startupIoOf (`$.clock.now().then(...)`) and spawnHookIoOf (`$.env.get(...).catch(...)`), while
//    reviewerIoOf, built the same way without those shapes, was not. 0.6.84, which passed, had chained shapes too
//    (`.catch` on `$.env.get` and `$.fs.read`), so this check does not hold it to 0.
// 10. Under hooks/, in a file that registers hooks, an io builder (a top-level function taking $ and returning an
//    object literal) hands out no setter: a closure whose whole body assigns a variable declared outside it (`setLast:
//    last => { lastRelease = last }`), written in its object, spread in from an argument (`...held`, `...spawnState`)
//    or named there by a const, when the builder has more than 12 members using $ or reaches, through a member passing
//    $ on to functions that are not builders, a builder that hands one out. Each call passing $ to such a builder is
//    reported, and so is an io written in a hook with more than 12 members using $ and a setter. A property write (`memo.last = last`) and a top-level function doing the assignment are not
//    setters. A guess calibrated to evidence, not a known rule: 0.6.113 was reported at releaseCaseIoOf($) (reaching
//    releaseIoOf's setLast through releaseRun), startupIoOf($, ...) (setRelay, setSlotDir, the held setters) and
//    spawnHookIoOf($, spawnState) (setNoLong, setNoContinue), while 0.6.84, which passed, built releaseIoOf($), with
//    setLast, in the release tool's own hook and handed mainHeld's setters only to the small usageIoOf.
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
  if (registers) wrapped(sf, say)
  if (registers) shared(sf, say)
  if (registers) plain(sf, say)
  if (registers) setters(sf, say)
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

// Check 7. The functions $ reaches from the hooks, the wrapped $ uses in each, then the calls that lead to one.
function wrapped(sf, say) {
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
  // A function and the name its $ has there: a hook's first parameter, or the parameter a call passed $ into.
  const holds = new Map()
  const queue = []
  const reach = (fn, name) => { if (name !== undefined && !holds.has(fn)) { holds.set(fn, name); queue.push(fn) } }
  const findHooks = n => { if (isFn(n) && isHook(n) && n.parameters[0]) reach(n, pname(n.parameters[0])); ts.forEachChild(n, findHooks) }
  findHooks(sf)
  const own = new Map()   // function -> wrapped $ uses in it
  const calls = new Map() // function -> calls in it passing $ to a top-level function
  const unwrapUp = n => { let p = n.parent; if (ts.isAwaitExpression(p)) { n = p; p = p.parent } return { n, p } }
  while (queue.length > 0) {
    const fn = queue.shift()
    const name = holds.get(fn)
    const uses = [], out = []
    const visit = k => {
      // A nested top-level-like function declaring its own $ is not this one's.
      if (k !== fn && isFn(k) && k.parameters.some(p => pname(p) === name)) return
      if (ts.isIdentifier(k) && k.text === name && !ts.isParameter(k.parent)) {
        const p = k.parent
        if (ts.isPropertyAccessExpression(p) && p.expression === k && ts.isPropertyAccessExpression(p.parent) && ts.isCallExpression(p.parent.parent) && p.parent.parent.expression === p.parent) {
          const call = p.parent.parent
          if (ts.isSpreadElement(unwrapUp(call).p)) uses.push([call, 'a $ call is spread'])
          for (const a of call.arguments) {
            if (ts.isAsExpression(a) || ts.isTypeAssertionExpression(a) || ts.isSatisfiesExpression(a) || ts.isNonNullExpression(a)) uses.push([a, 'a $ call has a cast or ! in its arguments'])
          }
        }
        if (ts.isCallExpression(p) && p.arguments.includes(k) && ts.isIdentifier(p.expression)) {
          const { p: up } = unwrapUp(p)
          if (ts.isSpreadElement(up) || ts.isSpreadAssignment(up)) uses.push([p, 'a call passing $ is spread'])
          if ((ts.isPropertyAccessExpression(up) || ts.isElementAccessExpression(up)) && up.expression === p &&
              !(ts.isPropertyAccessExpression(up) && ['then', 'catch', 'finally'].includes(up.name.text))) uses.push([p, 'a member is read straight off a call passing $'])
          const callee = top.get(p.expression.text)
          if (callee !== undefined) {
            out.push([p, callee])
            reach(callee, pname(callee.parameters[p.arguments.indexOf(k)] ?? {}))
          }
        }
      }
      ts.forEachChild(k, visit)
    }
    ts.forEachChild(fn.body, visit)
    own.set(fn, uses)
    calls.set(fn, out)
  }
  // The functions with a wrapped use, or passing $ to one that has or reaches one.
  const bad = new Set([...own].filter(([, uses]) => uses.length > 0).map(([fn]) => fn))
  for (let grew = true; grew;) {
    grew = false
    for (const [fn, out] of calls) if (!bad.has(fn) && out.some(([, c]) => bad.has(c))) { bad.add(fn); grew = true }
  }
  const nameOf = new Map([...top].map(([k, v]) => [v, k]))
  for (const uses of own.values()) for (const [n, why] of uses) say(n, `${why}: bind it to a const first (check 7)`)
  for (const out of calls.values()) {
    for (const [n, callee] of out) if (bad.has(callee)) say(n, `$ is passed to ${nameOf.get(callee)}, which reaches a wrapped $ use (check 7)`)
  }
}

// Check 8. The io builders, the switch cases that call each, then the members of each that use $.
function shared(sf, say) {
  const isFn = n => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
  const pname = p => ts.isIdentifier(p.name) ? p.name.text : undefined
  const MAX = 12
  const builders = new Map()
  for (const s of sf.statements) {
    if (!ts.isFunctionDeclaration(s) || !s.name || !s.body) continue
    const dollar = s.parameters.map(pname).find(n => n === '$')
    const ret = s.body.statements.find(ts.isReturnStatement)
    if (dollar && ret?.expression && ts.isObjectLiteralExpression(ret.expression)) builders.set(s.name.text, ret.expression)
  }
  // A member uses $ when it names it anywhere, in a call, a property read or a nested object.
  const usesDollar = n => (ts.isIdentifier(n) && n.text === '$') || (ts.forEachChild(n, usesDollar) ?? false)
  const cases = new Map() // builder name -> [call, case clause]
  const visit = n => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && builders.has(n.expression.text) && n.arguments.some(a => ts.isIdentifier(a) && a.text === '$')) {
      for (let p = n.parent; p && !isFn(p); p = p.parent) {
        if (ts.isCaseClause(p) || ts.isDefaultClause(p)) { cases.set(n.expression.text, [...(cases.get(n.expression.text) ?? []), [n, p]]); break }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  for (const [name, at] of cases) {
    const clauses = new Set(at.map(([, c]) => c))
    if (clauses.size < 2) continue
    const using = builders.get(name).properties.filter(p => usesDollar(p)).length
    if (using <= MAX) continue
    for (const [n] of at) say(n, `${name} is one io shared by ${clauses.size} switch cases with ${using} members using $ (over ${MAX}): give each case its own small io builder (check 8)`)
  }
}

// Check 9. The functions $ reaches from the hooks, then each $ call in them that is not a whole statement or value.
function plain(sf, say) {
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
  const holds = new Map()
  const queue = []
  const reach = (fn, name) => { if (name !== undefined && !holds.has(fn)) { holds.set(fn, name); queue.push(fn) } }
  const findHooks = n => { if (isFn(n) && isHook(n) && n.parameters[0]) reach(n, pname(n.parameters[0])); ts.forEachChild(n, findHooks) }
  findHooks(sf)
  const chain = p => ts.isPropertyAccessExpression(p) && ['then', 'catch', 'finally'].includes(p.name.text)
  // Why a $ call at `call` is not plain, or undefined when it is a whole statement or value.
  const where = call => {
    let n = call, p = call.parent
    if (ts.isAwaitExpression(p)) { n = p; p = p.parent }
    if (ts.isExpressionStatement(p) || ts.isReturnStatement(p)) return undefined
    if (ts.isArrowFunction(p) && p.body === n) return undefined
    if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name) && ts.isVariableDeclarationList(p.parent) &&
        (p.parent.flags & ts.NodeFlags.Const) !== 0) return undefined
    if (chain(p)) return `is chained with .${p.name.text}`
    if (ts.isConditionalExpression(p)) return 'is in a ternary'
    if (ts.isBinaryExpression(p)) return `is an operand of ${ts.tokenToString(p.operatorToken.kind)}`
    if (ts.isTemplateSpan(p)) return 'is in a template'
    if (ts.isVoidExpression(p)) return 'is under void'
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) return 'is an argument of another call'
    if (ts.isParenthesizedExpression(p)) return 'is parenthesized'
    if (ts.isVariableDeclaration(p)) return 'initializes something other than a const name'
    return 'is not a whole statement or value'
  }
  while (queue.length > 0) {
    const fn = queue.shift()
    const name = holds.get(fn)
    const visit = k => {
      if (k !== fn && isFn(k) && k.parameters.some(p => pname(p) === name)) return
      if (ts.isIdentifier(k) && k.text === name && !ts.isParameter(k.parent)) {
        const p = k.parent
        if (ts.isPropertyAccessExpression(p) && p.expression === k && ts.isPropertyAccessExpression(p.parent) && ts.isCallExpression(p.parent.parent) && p.parent.parent.expression === p.parent) {
          const why = where(p.parent.parent)
          if (why !== undefined) say(p.parent.parent, `a $ call ${why}: make it a whole statement, return value or const (check 9)`)
        }
        if (ts.isCallExpression(p) && p.arguments.includes(k)) {
          const up = ts.isAwaitExpression(p.parent) ? p.parent.parent : p.parent
          if (chain(up) && up.expression === p) say(p, `a call passing $ is chained with .${up.name.text}: use try/catch or a declared helper (check 9)`)
          const callee = ts.isIdentifier(p.expression) ? top.get(p.expression.text) : undefined
          if (callee !== undefined) reach(callee, pname(callee.parameters[p.arguments.indexOf(k)] ?? {}))
        }
      }
      ts.forEachChild(k, visit)
    }
    ts.forEachChild(fn.body, visit)
  }
  const helper = n => {
    if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
        n.initializer.parameters.some(p => pname(p) === '$')) say(n, 'a const helper takes $: declare it with function (check 9)')
    ts.forEachChild(n, helper)
  }
  helper(sf)
}

// Check 10. The io builders, which of them hand out a setter, then each call passing $ to one that is large or layered.
function setters(sf, say) {
  const isFn = n => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
  const pname = p => ts.isIdentifier(p.name) ? p.name.text : undefined
  const MAX = 12
  const top = new Map()
  const builders = new Map() // name -> [declaration, returned object literal]
  for (const s of sf.statements) {
    if (!ts.isFunctionDeclaration(s) || !s.name || !s.body) continue
    top.set(s.name.text, s)
    const ret = s.body.statements.find(ts.isReturnStatement)
    if (s.parameters.some(p => pname(p) === '$') && ret?.expression && ts.isObjectLiteralExpression(ret.expression)) builders.set(s.name.text, [s, ret.expression])
  }
  // Every const in the file with an object or a function as its value, by name (register()'s included).
  const consts = new Map()
  const collect = n => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer)
    ts.forEachChild(n, collect)
  }
  collect(sf)
  // A setter: a closure whose whole body assigns a name it does not declare (`x => { y = x }`, `() => { y = true }`).
  const assigns = fn => {
    const body = fn.body
    if (body === undefined) return false
    const stmts = ts.isBlock(body) ? body.statements : [body]
    if (stmts.length !== 1) return false
    const e = ts.isExpressionStatement(stmts[0]) ? stmts[0].expression : stmts[0]
    const own = new Set(fn.parameters.map(pname))
    return ts.isBinaryExpression(e) && e.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && e.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(e.left) && !own.has(e.left.text)
  }
  const isSetter = v => {
    if (v === undefined) return false
    if (ts.isArrowFunction(v) || ts.isFunctionExpression(v) || ts.isMethodDeclaration(v)) return assigns(v)
    if (ts.isIdentifier(v)) { const c = consts.get(v.text); return c !== undefined && (ts.isArrowFunction(c) || ts.isFunctionExpression(c)) && assigns(c) }
    return false
  }
  // Whether an object hands out a setter; `args` maps the builder's parameters to this call's arguments for a spread.
  const holds = (obj, args, seen = new Set()) => {
    if (obj === undefined || seen.has(obj)) return false
    seen.add(obj)
    if (ts.isIdentifier(obj)) return holds(args?.get(obj.text) ?? consts.get(obj.text), undefined, seen)
    if (!ts.isObjectLiteralExpression(obj)) return false
    return obj.properties.some(p => {
      if (ts.isSpreadAssignment(p)) return holds(p.expression, args, seen)
      if (ts.isShorthandPropertyAssignment(p)) return isSetter(p.name)
      if (ts.isMethodDeclaration(p)) return isSetter(p)
      if (ts.isPropertyAssignment(p)) return isSetter(p.initializer) || (ts.isObjectLiteralExpression(p.initializer) && holds(p.initializer, args, seen))
      return false
    })
  }
  const argsOf = (decl, call) => new Map(decl.parameters.map((p, i) => [pname(p), call?.arguments[i]]))
  const dollarAt = (call, name) => call.arguments.findIndex(a => ts.isIdentifier(a) && a.text === name)
  // Whether a builder's io, through its members passing $ on to functions that are not builders, reaches a call to
  // a builder that hands out a setter. Builders on the way stop the walk: they answer for themselves.
  const layered = name => {
    const [decl, obj] = builders.get(name)
    const seen = new Set()
    const queue = [[obj, pname(decl.parameters.find(p => pname(p) === '$'))]]
    while (queue.length > 0) {
      const [node, d] = queue.shift()
      let hit = false
      const visit = k => {
        if (hit) return
        if (ts.isCallExpression(k) && ts.isIdentifier(k.expression) && dollarAt(k, d) >= 0) {
          const callee = k.expression.text
          if (builders.has(callee)) {
            const [bd, bo] = builders.get(callee)
            if (holds(bo, argsOf(bd, k))) { hit = true; return }
          } else if (top.has(callee) && !seen.has(callee)) {
            seen.add(callee)
            const f = top.get(callee)
            queue.push([f.body, pname(f.parameters[dollarAt(k, d)])])
          }
        }
        ts.forEachChild(k, visit)
      }
      visit(node)
      if (hit) return true
    }
    return false
  }
  const usesDollar = n => (ts.isIdentifier(n) && n.text === '$') || (ts.forEachChild(n, usesDollar) ?? false)
  const visit = n => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && builders.has(n.expression.text) && n.arguments.some(a => ts.isIdentifier(a) && a.text === '$')) {
      const name = n.expression.text
      const [decl, obj] = builders.get(name)
      if (holds(obj, argsOf(decl, n))) {
        const using = obj.properties.filter(p => usesDollar(p)).length
        if (using > MAX) say(n, `${name} hands out a setter and has ${using} members using $ (over ${MAX}): write through a holder object's property or a top-level function (check 10)`)
        else if (layered(name)) say(n, `${name} hands out a setter through another function (check 10)`)
      } else if (layered(name)) say(n, `${name} reaches a builder that hands out a setter through another function: build that io in the hook (check 10)`)
    }
    if (ts.isObjectLiteralExpression(n) && !ts.isObjectLiteralExpression(n.parent) && holds(n)) {
      let fn = n.parent
      while (fn && !isFn(fn)) fn = fn.parent
      const using = n.properties.filter(p => usesDollar(p)).length
      if (fn && isHook(fn) && using > MAX) say(n, `an io written in a hook hands out a setter and has ${using} members using $ (over ${MAX}): write through a holder object's property (check 10)`)
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
