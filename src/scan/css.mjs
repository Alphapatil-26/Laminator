// Reading a project's stylesheets well enough to answer "what paints this?"
//
// WHY A HAND-WRITTEN PARSER AND NOT POSTCSS. This package has zero dependencies
// on purpose: it is a local dev tool people are asked to run inside their own
// repo, and "install these 40 transitive packages first" is the thing that stops
// them. What is needed here is much less than a CSS parser — every rule's
// PRELUDE and its LINE NUMBER — and that is a small, testable amount of work.
// Declarations are never parsed; the server re-reads the exact bytes when an
// edit is made, so nothing here has to round-trip.
//
// WHAT IT DELIBERATELY GETS "WRONG": it does not resolve `@import`, does not
// expand nesting into full selectors, and does not evaluate `@supports`. A
// nested rule is indexed under its own tokens, which is enough to find it —
// the browser confirms the real match with `element.matches()`, so this side
// only has to be a good CANDIDATE generator, never an authority.

/** Strip comments without disturbing line numbering. */
function decomment(src) {
    let out = ''
    let i = 0
    while (i < src.length) {
        if (src[i] === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2)
            const chunk = src.slice(i, end < 0 ? src.length : end + 2)
            // Newlines are kept so every later line number stays true.
            out += chunk.replace(/[^\n]/g, ' ')
            i = end < 0 ? src.length : end + 2
            continue
        }
        if (src[i] === '"' || src[i] === "'") {
            const q = src[i]
            let j = i + 1
            while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1
            out += src.slice(i, j + 1)
            i = j + 1
            continue
        }
        out += src[i]
        i++
    }
    return out
}

/**
 * Every rule in a stylesheet: its prelude, its line, and the at-rules above it.
 *
 * At-rules that CONTAIN rules (`@media`, `@supports`, `@layer`, `@container`)
 * are descended into and recorded as context, because "this only applies in
 * dark mode" is exactly the kind of thing a reader needs and a flat list of
 * selectors destroys. At-rules whose bodies are not rules (`@keyframes`,
 * `@font-face`, `@property`) are skipped whole — their inner blocks look like
 * selectors (`from`, `0%`) and would pollute the index with nonsense.
 */
export function rules(src) {
    const text = decomment(src)
    const found = []
    const stack = []
    let buf = ''
    let line = 1
    let bufLine = 1
    let i = 0

    const OPAQUE = /^@(keyframes|-\w+-keyframes|font-face|property|counter-style|font-feature-values|page|viewport)\b/

    while (i < text.length) {
        const ch = text[i]
        if (ch === '\n') {
            line++
            if (!buf.trim()) bufLine = line
            buf += ch
            i++
            continue
        }
        if (ch === '"' || ch === "'") {
            const q = ch
            let j = i + 1
            while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1
            buf += text.slice(i, j + 1)
            i = j + 1
            continue
        }
        if (ch === '{') {
            const prelude = buf.trim()
            buf = ''
            if (OPAQUE.test(prelude)) {
                // Skip the whole body, tracking depth and newlines.
                let depth = 1
                i++
                while (i < text.length && depth > 0) {
                    if (text[i] === '\n') line++
                    else if (text[i] === '{') depth++
                    else if (text[i] === '}') depth--
                    i++
                }
                bufLine = line
                continue
            }
            if (prelude.startsWith('@')) {
                stack.push(prelude)
            } else if (prelude) {
                found.push({ prelude, line: bufLine, at: [...stack] })
                // A rule's body may itself contain nested rules; treat it as a
                // context frame so they are found too.
                stack.push(prelude)
            } else {
                stack.push('')
            }
            i++
            bufLine = line
            continue
        }
        if (ch === '}') {
            stack.pop()
            buf = ''
            i++
            bufLine = line
            continue
        }
        if (ch === ';' && !buf.includes('{')) {
            // A declaration, or an @import/@charset statement. Either way it is
            // not a rule and the buffer must not leak into the next prelude.
            buf = ''
            i++
            bufLine = line
            continue
        }
        buf += ch
        i++
    }
    return found
}

/**
 * The tokens a prelude could be looked up by.
 *
 * Classes, ids and attribute names — the things that identify an element in a
 * browser. Bare tag selectors are DELIBERATELY not indexed: `div` matches half
 * a page, so indexing it makes every lookup return everything and the index
 * stops narrowing anything. The browser's own `matches()` is what confirms a
 * candidate, so a slightly narrow index costs nothing and a wide one costs
 * every query.
 */
export function tokens(prelude) {
    const out = new Set()
    for (const m of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add('.' + m[1])
    for (const m of prelude.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) out.add('#' + m[1])
    for (const m of prelude.matchAll(/\[\s*([\w-]+)/g)) out.add('[' + m[1] + ']')
    return [...out]
}

/**
 * Build the lookup: token → the rules that mention it.
 *
 * This is the "query tree" the whole tool rests on. Without it, answering "what
 * paints this element" means reading every stylesheet in the project on every
 * question; with it, the browser sends one token and gets back a handful of
 * candidates to confirm. On a large app that is the difference between a
 * hundred kilobytes per click and a few hundred bytes.
 */
export function indexRules(files) {
    const index = new Map()
    let count = 0
    for (const { file, src } of files) {
        for (const r of rules(src)) {
            count++
            const entry = { file, line: r.line, prelude: r.prelude, at: r.at.filter((x) => x.startsWith('@')) }
            for (const t of tokens(r.prelude)) {
                if (!index.has(t)) index.set(t, [])
                index.get(t).push(entry)
            }
        }
    }
    return { index, count }
}

/** Serialisable form — a Map does not survive JSON. */
export const indexToJSON = (index) => Object.fromEntries([...index].map(([k, v]) => [k, v]))
