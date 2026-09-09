// The annotation queue, on disk under .laminator/.
//
// Records are AFS v1.1 (agentation.dev/schema/annotation.v1.1.json) with a
// `laminator` extension, so anything that reads AFS can read this queue.

import { promises as fs } from 'fs'
import path from 'path'

const rel = (root, ...p) => path.join(root, '.laminator', ...p)

async function ensure(root) {
    const dir = rel(root)
    await fs.mkdir(dir, { recursive: true })
    const ignore = path.join(dir, '.gitignore')
    try {
        await fs.access(ignore)
    } catch {
        await fs.writeFile(ignore, '*\n', 'utf8')
    }
}

export async function read(root) {
    try {
        const raw = JSON.parse(await fs.readFile(rel(root, 'queue.json'), 'utf8'))
        return Array.isArray(raw) ? raw : []
    } catch {
        return []
    }
}

export async function write(root, list) {
    await ensure(root)
    await fs.writeFile(rel(root, 'queue.json'), JSON.stringify(list, null, 2), 'utf8')
}

/**
 * Write one finding's screenshot and return its repo-relative path.
 *
 * Kept out of queue.json, which is polled every three seconds; base64 would put
 * a megabyte on every poll. The id becomes a filename, so anything but the
 * shape the server mints is refused. A cleaned path is still somebody else's.
 */
export async function writeShot(root, id, dataUrl) {
    if (typeof dataUrl !== 'string') return null
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
    if (!m) return null
    if (m[1].length > 8_000_000) return null
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
    await ensure(root)
    const dir = rel(root, 'shots')
    await fs.mkdir(dir, { recursive: true })
    try {
        await fs.writeFile(path.join(dir, `${id}.png`), Buffer.from(m[1], 'base64'))
    } catch {
        return null
    }
    return `.laminator/shots/${id}.png`
}

export async function add(root, incoming, shot) {
    const list = await read(root)
    // Stamped here. A wrong browser clock or an id that collides after a reload
    // would corrupt the queue with nothing to show for it.
    const item = {
        ...incoming,
        id: `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        status: incoming.status ?? 'pending',
    }
    const png = shot ? await writeShot(root, item.id, shot) : null
    if (png) item.screenshot = png
    list.push(item)
    await write(root, list)
    return item
}

/**
 * What the tool cost and what it avoided, in bytes.
 *
 * Not tokens. A chars-per-token constant was measured twice against real agent
 * transcripts and came back at 0.99 then 1.82, where prose is nearer 3.5, so
 * the figure is not published. Bytes can be measured, so bytes are reported.
 *
 * Conservative on purpose: a stylesheet counts once per batch however many
 * findings point into it, unanchored findings score zero, and the review file's
 * own size is subtracted.
 */
export async function ledger(root, entry) {
    const file = rel(root, 'savings.json')
    let data = { version: 1, entries: [] }
    try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8'))
        if (raw && Array.isArray(raw.entries)) data = raw
    } catch { /* first run */ }
    if (entry) {
        data.entries.push(entry)
        // Bounded. This is a dev ledger.
        if (data.entries.length > 200) data.entries = data.entries.slice(-200)
        await ensure(root)
        await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
    }
    const sum = { batches: data.entries.length, annotations: 0, anchored: 0, screenshots: 0, avoidedBytes: 0, suppliedBytes: 0 }
    for (const e of data.entries) {
        sum.annotations += e.annotations || 0
        sum.anchored += e.anchored || 0
        sum.screenshots += e.screenshots || 0
        sum.avoidedBytes += e.avoidedBytes || 0
        sum.suppliedBytes += e.suppliedBytes || 0
    }
    return sum
}

/** Stylesheet bytes an anchored batch saved reading. Counted once per file:
 *  three findings in one sheet still only save reading it once. */
export async function avoided(root, list, writable) {
    const want = new Set()
    let anchored = 0
    for (const a of list) {
        const f = a.laminator?.rule?.file
        if (!f) continue
        anchored++
        want.add(f)
    }
    let bytes = 0
    for (const f of want) {
        const abs = writable.get(f)
        if (!abs) continue
        try { bytes += (await fs.stat(abs)).size } catch { /* moved or deleted */ }
    }
    return { bytes, anchored }
}

export async function update(root, id, patch) {
    const list = await read(root)
    const i = list.findIndex((a) => a.id === id)
    if (i < 0) return null
    // id is never patchable, or the agent loses track of what it is working on.
    const { id: _drop, ...safe } = patch ?? {}
    void _drop
    const next = { ...list[i], ...safe }
    if (safe.status === 'resolved' || safe.status === 'dismissed') {
        next.resolvedAt = next.resolvedAt ?? new Date().toISOString()
        next.resolvedBy = next.resolvedBy ?? 'agent'
    }
    list[i] = next
    await write(root, list)
    return next
}

export async function reply(root, id, role, content) {
    const list = await read(root)
    const i = list.findIndex((a) => a.id === id)
    if (i < 0) return null
    list[i] = {
        ...list[i],
        thread: [
            ...(list[i].thread ?? []),
            { id: `msg_${Date.now().toString(36)}`, role: role === 'human' ? 'human' : 'agent', content, timestamp: Date.now() },
        ],
    }
    await write(root, list)
    return list[i]
}

export async function remove(root, id) {
    const list = (await read(root)).filter((a) => a.id !== id)
    await write(root, list)
    return list
}

export const isOpen = (a) => a.status !== 'resolved' && a.status !== 'dismissed'

/** The review file an agent is pointed at. */
export function toMarkdown(list, config, { brief } = {}) {
    const open = list.filter(isOpen)
    const out = []
    out.push(`# UI review — ${new Date().toLocaleString()}`)
    out.push('')
    out.push(
        `${open.length} annotation${open.length === 1 ? '' : 's'} captured in the running app. ` +
            `Positions and offsets were MEASURED in the live DOM, not estimated. ` +
            `Anything with a **Rule** line carries the exact file and line that paints it.`,
    )
    out.push('')
    out.push(
        `Project: **${config.project.name}** · ${config.project.frameworks.join(', ') || 'no framework detected'}` +
            ` · styling: ${config.project.styling.join(', ') || 'unknown'}`,
    )
    out.push('')

    const b = brief?.trim()
    if (b) {
        // Above the findings, since it changes how they should be read.
        out.push('## Standing context from the owner')
        out.push('')
        out.push(b)
        out.push('')
        out.push('---')
        out.push('')
    }

    open.forEach((a, i) => {
        out.push(`## Annotation #${i + 1} — ${a.element ?? 'element'}`)
        out.push('')
        out.push(`**Feedback:** ${String(a.comment ?? '').trim()}`)
        out.push('')
        if (a.selectedText) {
            out.push(`**Selected text:** "${String(a.selectedText).trim()}"`)
            out.push('')
        }
        const tags = []
        if (a.intent) tags.push(`**Intent:** ${a.intent}`)
        if (a.severity) tags.push(`**Severity:** ${a.severity}`)
        if (tags.length) {
            out.push(tags.join(' · '))
            out.push('')
        }

        const rule = a.laminator?.rule
        if (rule) {
            out.push(`**Rule:** \`${rule.prelude}\` — ${rule.file}:${rule.line}`)
            if (rule.at?.length) out.push(`**Inside:** ${rule.at.join(' › ')}`)
            if (typeof rule.siblings === 'number') {
                out.push(
                    `**Applies to:** ${rule.siblings} element${rule.siblings === 1 ? '' : 's'} on this page` +
                        (rule.siblings > 1 ? ' — an edit here moves all of them' : ''),
                )
            }
        } else if (a.laminator?.styling === 'utility') {
            // Otherwise an agent goes hunting for a rule that does not exist.
            out.push(`**No stylesheet rule.** This element is styled by utility classes — edit the \`class\` attribute.`)
            if (a.cssClasses) out.push(`**Classes:** \`${a.cssClasses}\``)
        } else {
            out.push(`**No authored rule found.** Search the source for the classes below.`)
            if (a.cssClasses) out.push(`**Classes:** \`${a.cssClasses}\``)
        }
        out.push('')

        out.push(`**Where:** \`${a.elementPath}\``)
        if (a.url) out.push(`**Page:** ${a.url}`)
        if (a.reactComponents) out.push(`**Components:** ${a.reactComponents}`)
        if (a.computedStyles) out.push(`**Computed:** ${a.computedStyles}`)
        if (a.laminator?.viewport) out.push(`**Viewport:** ${a.laminator.viewport.w}×${a.laminator.viewport.h}`)
        out.push('')
        out.push(`<sub>id \`${a.id}\` — resolve it with the API call in the command file</sub>`)
        out.push('')
    })

    return out.join('\n')
}

export async function writeExport(root, name, text) {
    await ensure(root)
    const file = rel(root, name)
    await fs.writeFile(file, text, 'utf8')
    return path.relative(root, file).split(path.sep).join('/')
}
