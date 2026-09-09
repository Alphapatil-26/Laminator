// Answering "what paints this element", and changing it.
//
// The browser cannot read the source and the server cannot run
// element.matches(), so the work splits at that seam: the server proposes
// candidates from the index, the page confirms which ones match. Neither side
// has to be right alone, which is why the index can be approximate.

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
    // The prelude may wrap, so scan forward for the brace.
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
    // Top-level semicolons only, or url(a;b) gets torn in half.
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
 * Capped: an element carrying a utility class used in four hundred rules would
 * otherwise return four hundred rules, and the page would spend longer
 * confirming them than the lookup saved.
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
    // Only for what survived the cap. This is most of the endpoint's cost.
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
 * Change one declaration inside a rule the scan says is writable.
 *
 * The endpoint takes a file, a line, a property and a value. There is no
 * free-text write, because a dev tool that can put arbitrary bytes into
 * arbitrary files is a much more dangerous thing than this one.
 */
export async function edit(root, config, { file, line, property, value }) {
    const writable = writableStyles(config)
    const abs = writable.get(file)
    if (!abs) return { ok: false, why: `${file} is not in this project's writable stylesheets` }
    if (!/^[-a-zA-Z][\w-]*$/.test(String(property ?? ''))) return { ok: false, why: 'bad property name' }
    const v = String(value ?? '')
    // A brace or semicolon could close the rule and open something else. No
    // legitimate value here needs them, so refuse instead of escaping.
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

    // So a session's edits can be read back as a list.
    const log = path.join(root, '.laminator', 'changes.log')
    const verb = previous === null ? 'add' : 'change'
    const shown = previous === null ? `${property}: ${v}` : `${property}: ${previous} -> ${v}`
    await fs.appendFile(log, `${new Date().toISOString()}\t${verb}\t${file}:${line}\t${shown}\n`, 'utf8').catch(() => {})

    return { ok: true, previous, next: v, file, line }
}
