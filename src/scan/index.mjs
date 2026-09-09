// The scan: everything the tool needs to know about a project it has never seen.
//
// Runs once at `laminator init` and again whenever `laminator scan` is asked for.
// It writes two files and nothing else:
//
//   .laminator/config.json   what this project IS — frameworks, styling, which
//                           stylesheets may be edited, and which may not
//   .laminator/index.json    the selector index: token -> candidate rules
//
// Both are plain JSON on purpose. A person who wants to know why the tool
// pointed at a line can open the index and see, and a person who disagrees with
// the scan can edit the config by hand. A tool that decides things about your
// repo inside a binary cache is one you cannot argue with.

import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { indexRules, indexToJSON } from './css.mjs'
import { classifyStyles, detect, sourceRoots, walk } from './project.mjs'

export const DIR = '.laminator'

export async function scan(root, { onProgress } = {}) {
    // A re-scan must NOT mint a new token: the overlay already in a browser tab
    // carries the old one, and silently invalidating it turns every later click
    // into an unexplained 401.
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
            // Unreadable is not fatal — it is one fewer place to look, and the
            // count below will not match `editable`, which is the honest signal.
        }
    }

    onProgress?.('indexing selectors')
    const { index, count } = indexRules(loaded)

    const config = {
        version: 1,
        scannedAt: new Date().toISOString(),
        // Shared secret between this server and the overlay it serves. Kept in
        // a gitignored file; see the header of server/index.mjs for what it
        // actually defends against.
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
        // Everything below is meant to be edited by hand when the scan guesses
        // wrong; nothing regenerates them except an explicit `laminator scan`.
        overrides: existing?.overrides ?? {
            /** Selector for the app's main surface, used to keep element paths
             *  short. Empty means "work it out from the document". */
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
    // The whole directory is working state, not source. Written once so a scan
    // never turns up in `git status` and surprise anybody.
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
 * The scan's answer plus the config's overrides, resolved to absolute paths and
 * checked to be INSIDE the project. That last part is the whole security model
 * of the write endpoint: a request names a file, and only a path that survives
 * this is ever opened.
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
        // `path.resolve` collapses `..`, so anything that escapes the project is
        // visible here and refused rather than sanitised into something else.
        if (!abs.startsWith(path.resolve(root) + path.sep)) continue
        map.set(rel, abs)
    }
    return map
}
