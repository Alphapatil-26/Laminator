// The scan. Writes two files and nothing else:
//
//   .laminator/config.json   frameworks, styling, which stylesheets are editable
//   .laminator/index.json    selector token -> candidate rules
//
// Both are plain JSON so you can open them and argue with what the scan decided.

import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { indexRules, indexToJSON } from './css.mjs'
import { classifyStyles, detect, sourceRoots, walk } from './project.mjs'

export const DIR = '.laminator'

export async function scan(root, { onProgress } = {}) {
    // A re-scan keeps the old token. Minting a new one would 401 every click in
    // any tab that still has the overlay loaded.
    const existing = await readConfig(root)
    const started = Date.now()
    onProgress?.('walking the project')
    const { files, truncated } = await walk(root)

    onProgress?.(`detecting frameworks (${files.length} files)`)
    const project = await detect(root, files)
    const { editable, excluded } = classifyStyles(files)
    const roots = sourceRoots(files)

    onProgress?.(`reading ${editable.length} stylesheet${editable.length === 1 ? '' : 's'}`)
    const loaded = []
    let bytes = 0
    for (const rel of editable) {
        try {
            const src = await fs.readFile(path.join(root, rel), 'utf8')
            bytes += Buffer.byteLength(src, 'utf8')
            loaded.push({ file: rel, src })
        } catch {
        }
    }

    onProgress?.('indexing selectors')
    const { index, count } = indexRules(loaded)

    const config = {
        version: 1,
        scannedAt: new Date().toISOString(),
        // Shared with the overlay this server hands out. server/index.mjs says
        // what it defends against.
        token: existing?.token ?? randomBytes(24).toString('hex'),
        root: path.resolve(root),
        project,
        sourceRoots: roots,
        styles: {
            editable: loaded.map((l) => l.file),
            excluded,
        },
        stats: {
            files: files.length,
            filesTruncated: truncated,
            stylesheets: loaded.length,
            stylesheetBytes: bytes,
            rules: count,
            tokens: index.size,
            tookMs: Date.now() - started,
        },
        // Hand-edit these when the scan guesses wrong. They survive a re-scan.
        overrides: existing?.overrides ?? {
            /** The app's main container. Empty means work it out. */
            surfaceRoot: '',
            /** Extra stylesheets to treat as editable, if the scan missed one. */
            includeStyles: [],
            /** Stylesheets to refuse edits to, whatever the scan decided. */
            excludeStyles: [],
        },
    }

    return { config, index }
}

export async function write(root, { config, index }) {
    const dir = path.join(root, DIR)
    await fs.mkdir(dir, { recursive: true })
    // Working state, so it stays out of git status.
    const ignore = path.join(dir, '.gitignore')
    try {
        await fs.access(ignore)
    } catch {
        await fs.writeFile(ignore, '*\n', 'utf8')
    }
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(indexToJSON(index)), 'utf8')
    return dir
}

export async function readConfig(root) {
    try {
        return JSON.parse(await fs.readFile(path.join(root, DIR, 'config.json'), 'utf8'))
    } catch {
        return null
    }
}

export async function readIndex(root) {
    try {
        return JSON.parse(await fs.readFile(path.join(root, DIR, 'index.json'), 'utf8'))
    } catch {
        return {}
    }
}

/**
 * The stylesheets the server will accept an edit to.
 *
 * The scan's answer plus any overrides, resolved and checked to be inside the
 * project. That check is the write endpoint's security model: a request names a
 * file, and only a path that survives this is ever opened.
 */
export function writableStyles(config) {
    const root = config.root
    const listed = [
        ...config.styles.editable,
        ...(config.overrides?.includeStyles ?? []),
    ].filter((f) => !(config.overrides?.excludeStyles ?? []).includes(f))

    const map = new Map()
    for (const rel of listed) {
        const abs = path.resolve(root, rel)
        // resolve() collapses `..`, so an escaping path is visible here.
        if (!abs.startsWith(path.resolve(root) + path.sep)) continue
        map.set(rel, abs)
    }
    return map
}
