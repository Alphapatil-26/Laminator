// Serves the docs. Used by `npm run site` locally and as the start command on
// Railway or any other host.
//
// This is the ONLY part of Laminator that is meant to be reachable from a
// network, so it is deliberately the dullest: it binds to 0.0.0.0 (a container
// has to), serves exactly the files in this folder, and does nothing else. It
// shares no code with the tool's own sidecar, which binds to 127.0.0.1 and can
// write to your source — keeping those two apart is the point of the split.

import { createServer } from 'http'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3000)

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.json': 'application/json; charset=utf-8',
}

createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    let rel = decodeURIComponent(url.pathname)
    if (rel.endsWith('/')) rel += 'index.html'

    // Resolve first, then check containment. A request for `/../../etc/passwd`
    // resolves to a real path outside this folder, and the only reliable way to
    // refuse it is to compare the RESOLVED path — not to look for `..` in the
    // string, which misses every encoding of it.
    const file = path.resolve(HERE, '.' + rel)
    if (file !== HERE && !file.startsWith(HERE + path.sep)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        return res.end('no')
    }

    try {
        const buf = await fs.readFile(file)
        res.writeHead(200, {
            'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
            // Short, not immutable: this is one hand-edited page, and a stale
            // copy of the install instructions is worse than a re-fetch.
            'cache-control': 'public, max-age=300',
            'x-content-type-options': 'nosniff',
        })
        res.end(buf)
    } catch {
        try {
            const buf = await fs.readFile(path.join(HERE, 'index.html'))
            res.writeHead(404, { 'content-type': TYPES['.html'] })
            res.end(buf)
        } catch {
            res.writeHead(404, { 'content-type': 'text/plain' })
            res.end('not found')
        }
    }
    // 0.0.0.0 because a container's port mapping cannot reach a loopback bind.
}).listen(PORT, '0.0.0.0', () => console.log(`laminator docs on :${PORT}`))
