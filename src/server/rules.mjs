// Answering "what paints this element", and changing it.
//
// The browser cannot read the project's source, and the server cannot run
// `element.matches()`. So the work is split at exactly that seam: the server
// proposes CANDIDATES from the selector index, and the page confirms which of
// them actually match the element in front of it. Neither side has to be right
// on its own, which is why the index is allowed to be approximate.

import { promises as fs } from 'fs'
import path from 'path'
import { readIndex, writableStyles } from '../scan/index.mjs'

/** The declarations of the rule that begins at `line`, read from the file. */
async function declarationsAt(abs, line) {
    let src
    try {
        src = await fs.readFile(abs, 'utf8')
    } catch {
        return { declarations: {}, body: '', start: -1, end: -1 }
    }
    const lines = src.split('\n')
    // The prelude may wrap, so the brace is found by scanning forward from the
    // recorded line rather than assumed to be on it.
    let idx = 0
    for (let i = 0; i < line - 1 && i < lines.length; i++) idx += lines[i].length + 1
    const open = src.indexOf('{', idx)
    if (open < 0) return { declarations: {}, body: '', start: -1, end: -1 }
    let depth = 1
    let i = open + 1
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') depth--
        i++
    }
    const body = src.slice(open + 1, i - 1)
    const declarations = {}
    // Split on top-level semicolons only: a `url(a;b)` or a nested block would
    // otherwise be torn in half.
    let buf = ''
    let d = 0
    for (const ch of body) {
        if (ch === '{') d++
        else if (ch === '}') d--
        if (ch === ';' && d === 0) {
            const c = buf.indexOf(':')
            if (c > 0) declarations[buf.slice(0, c).trim()] = buf.slice(c + 1).trim()
            buf = ''
            continue
        }
        buf += ch
    }
    const c = buf.indexOf(':')
    if (c > 0 && buf.trim()) declarations[buf.slice(0, c).trim()] = buf.slice(c + 1).trim()
    return { declarations, body, start: open + 1, end: i - 1 }
}

/**
 * Candidate rules for a set of tokens.
 *
 * Ordered most-specific-token-first so the page checks the likeliest anchors
 * before the generic ones. Capped, because an element carrying a utility class
 * used in four hundred rules would otherwise return four hundred rules and the
 * page would spend longer confirming than the whole lookup was meant to save.
 */
export async function candidates(root, config, tokenList, limit = 60) {
    const index = await readIndex(root)
    const seen = new Set()
    const out = []
    for (const t of tokenList) {
        for (const r of index[t] ?? []) {
            const key = `${r.file}:${r.line}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({ ...r, token: t })
            if (out.length >= limit) break
        }
        if (out.length >= limit) break
    }
    // Declarations are read only for what survived the cap — reading them for
    // every candidate is most of the cost of this endpoint.
    const writable = writableStyles(config)
    for (const r of out) {
        const abs = writable.get(r.file)
        if (!abs) {
            r.declarations = {}
            r.writable = false
            continue
        }
        const { declarations } = await declarationsAt(abs, r.line)
        r.declarations = declarations
        r.writable = true
    }
    return out
}

/**
 * Change ONE declaration inside a rule the scan says is writable.
 *
 * Deliberately narrow. There is no free-text write and never will be: the
 * endpoint takes a file, a line, a property and a value, resolves the file
 * against the scan's allowlist, and rewrites one declaration in place. A dev
 * tool that can write arbitrary bytes into arbitrary files is a different and
 * much more dangerous thing than this one.
 */
export async function edit(root, config, { file, line, property, value }) {
    const writable = writableStyles(config)
    const abs = writable.get(file)
    if (!abs) return { ok: false, why: `${file} is not in this project's writable stylesheets` }
    if (!/^[-a-zA-Z][\w-]*$/.test(String(property ?? ''))) return { ok: false, why: 'bad property name' }
    const v = String(value ?? '')
    // A value containing a brace or a semicolon could close the rule and open
    // something else. Refused rather than escaped: there is no legitimate
    // declaration value here that needs them.
    if (/[{};]/.test(v)) return { ok: false, why: 'value may not contain { } or ;' }

    const src = await fs.readFile(abs, 'utf8')
    const { start, end, declarations } = await declarationsAt(abs, line)
    if (start < 0) return { ok: false, why: 'could not find that rule — re-run `laminator scan`' }

    const body = src.slice(start, end)
    const previous = declarations[property] ?? null
    const re = new RegExp(`(^|;|\\n)(\\s*)${property.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:[^;}]*`, 'm')
    let nextBody
    if (previous !== null && re.test(body)) {
        nextBody = body.replace(re, (_m, lead, indent) => `${lead}${indent}${property}: ${v}`)
    } else {
        // New declaration, indented like the last one so the file keeps its shape.
        const indent = (body.match(/\n(\s+)\S/) ?? [, '    '])[1]
        const trimmed = body.replace(/\s*$/, '')
        nextBody = `${trimmed}${trimmed.endsWith(';') || !trimmed ? '' : ';'}\n${indent}${property}: ${v};\n`
    }

    const next = src.slice(0, start) + nextBody + src.slice(end)
    await fs.writeFile(abs, next, 'utf8')

    // A change log, so a session's edits can be read back as a list rather than
    // reconstructed from a diff.
    const log = path.join(root, '.laminator', 'changes.log')
    const verb = previous === null ? 'add' : 'change'
    const shown = previous === null ? `${property}: ${v}` : `${property}: ${previous} -> ${v}`
    await fs.appendFile(log, `${new Date().toISOString()}\t${verb}\t${file}:${line}\t${shown}\n`, 'utf8').catch(() => {})

    return { ok: true, previous, next: v, file, line }
}
