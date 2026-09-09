// Serves the docs. Used by `npm run site` locally and as the start command on
// Railway or any other host.
//
// The only part of Laminator meant to be reachable from a network, so it is the
// dullest thing here: binds to 0.0.0.0 because a container has to, serves the
// files in this folder, does nothing else. It shares no code with the tool's own
// sidecar, which stays on 127.0.0.1 and can write to your source.

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

    // Resolve first, then check containment. Looking for `..` in the string
    // misses every encoding of it; comparing the resolved path does not.
    const file = path.resolve(HERE, '.' + rel)
    if (file !== HERE && !file.startsWith(HERE + path.sep)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        return res.end('no')
    }

    try {
        const buf = await fs.readFile(file)
        res.writeHead(200, {
            'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
            // Short. A stale copy of the install instructions costs more than
            // a re-fetch does.
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
