// Reading stylesheets well enough to answer "what paints this?".
//
// Hand-written because all we need is each rule's prelude and its line number.
// Declarations are left alone; the server re-reads the exact bytes when an edit
// is made, so nothing here has to round-trip. Keeping it to that avoids a
// PostCSS dependency in a package that has none.
//
// It does not resolve @import, expand nesting into full selectors, or evaluate
// @supports. A nested rule is indexed under its own tokens, which is enough to
// find it. The browser confirms the real match with element.matches(), so this
// side only has to generate good candidates.
//
// TODO: Sass and Less nesting is indexed by the tokens on each nested rule, so
// `&:hover` lands under whatever classes it mentions and not under the parent's.
// Finds the right file and line; the prelude shown is the fragment, not the
// resolved selector.

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
 * Every rule in a stylesheet: prelude, line, and the at-rules wrapping it.
 *
 * @media, @supports, @layer and @container are descended into and kept as
 * context, since "only in dark mode" is worth knowing. @keyframes, @font-face
 * and @property are skipped whole: their inner blocks look like selectors
 * (`from`, `0%`) and would land in the index as rules nothing can match.
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
                // The body may contain nested rules, so push a context frame.
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
            // A declaration or an @import statement. Either way the buffer must
            // not leak into the next prelude.
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
 * The tokens a prelude can be looked up by: classes, ids, attribute names.
 *
 * Bare tag selectors are left out. `div` matches half a page, so indexing it
 * makes every lookup return everything. The browser confirms candidates itself,
 * so a narrow index costs nothing and a wide one costs every query.
 */
export function tokens(prelude) {
    const out = new Set()
    for (const m of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add('.' + m[1])
    for (const m of prelude.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) out.add('#' + m[1])
    for (const m of prelude.matchAll(/\[\s*([\w-]+)/g)) out.add('[' + m[1] + ']')
    return [...out]
}

/**
 * Build the lookup: token to the rules that mention it.
 *
 * Without it, answering "what paints this" means reading every stylesheet on
 * every question. With it the browser sends one token and gets back a handful
 * of candidates. On a large app that is a few hundred bytes per click instead
 * of a few hundred kilobytes.
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

/** A Map does not survive JSON. */
export const indexToJSON = (index) => Object.fromEntries([...index].map(([k, v]) => [k, v]))
