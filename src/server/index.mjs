// The local sidecar. Binds to 127.0.0.1 and talks to nothing else.
//
// A separate process rather than a dev-server plugin, so the same code works
// whether your dev server is Vite, Next, Rails or Django.
//
// The threat worth knowing about: a server on localhost is reachable by any
// page in your browser, including a site on the internet. Same-origin policy
// stops that page reading the response; it does not stop the request. Since
// this process can write stylesheets, a drive-by POST would be a real edit to a
// real file. So:
//
//   - Requests with an Origin must come from localhost and carry the token
//     minted at init. A foreign page can send the request but cannot learn the
//     token, because the script holding it is only served to localhost.
//   - Requests with no Origin are local processes such as curl or the agent
//     working the queue. A page cannot suppress its own Origin header.

import { createServer } from 'http'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { readConfig } from '../scan/index.mjs'
import { candidates, edit } from './rules.mjs'
import { writableStyles } from '../scan/index.mjs'
import { AGENTS, canContinue, installed, launch, sessions } from './launch.mjs'
import * as store from './store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

const json = (res, code, body, origin) => {
    res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    })
    res.end(JSON.stringify(body))
}

async function body(req) {
    const chunks = []
    for await (const c of req) {
        chunks.push(c)
        // A screenshot is the largest legitimate payload and is nowhere near this.
        if (chunks.reduce((n, b) => n + b.length, 0) > 12 * 1024 * 1024) throw new Error('too large')
    }
    if (!chunks.length) return {}
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new Error('bad json')
    }
}

export async function serve(root, { port = 7317, quiet = false } = {}) {
    const config = await readConfig(root)
    if (!config) throw new Error('no scan found — run `laminator init` first')
    const token = config.token
    if (!token) throw new Error('config has no token — re-run `laminator init`')

    const clientSrc = await fs.readFile(path.join(HERE, '..', 'client', 'overlay.js'), 'utf8')

    const server = createServer(async (req, res) => {
        const origin = req.headers.origin
        const url = new URL(req.url, `http://127.0.0.1:${port}`)

        // ── who is allowed to speak ──────────────────────────────────────
        if (origin && !LOCAL.test(origin)) {
            // No CORS headers, so the page cannot read the answer either.
            res.writeHead(403, { 'content-type': 'text/plain' })
            return res.end('laminator only serves localhost origins')
        }
        const allow = origin ?? null

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                ...(allow ? { 'access-control-allow-origin': allow, vary: 'Origin' } : {}),
                'access-control-allow-methods': 'GET,POST,OPTIONS',
                'access-control-allow-headers': 'content-type,x-laminator-token',
                'access-control-max-age': '600',
            })
            return res.end()
        }

        const mutating = req.method === 'POST'
        if (origin && mutating && req.headers['x-laminator-token'] !== token) {
            return json(res, 401, { error: 'bad or missing x-laminator-token' }, allow)
        }

        try {
            // ── the overlay itself ───────────────────────────────────────
            if (url.pathname === '/client.js') {
                res.writeHead(200, {
                    'content-type': 'application/javascript; charset=utf-8',
                    'cache-control': 'no-store',
                    ...(allow ? { 'access-control-allow-origin': allow, vary: 'Origin' } : {}),
                })
                // The token is baked in, and this file only goes to localhost.
                return res.end(
                    `window.__LAMINATOR__=${JSON.stringify({
                        port, token,
                        project: config.project,
                        surfaceRoot: config.overrides?.surfaceRoot || '',
                        agents: Object.fromEntries(
                            Object.entries(AGENTS).map(([id, s]) => [id, {
                                label: s.label,
                                supportsContinue: s.supportsContinue,
                                models: s.models || ['default'],
                                efforts: s.effortFlag ? s.efforts || [] : [],
                            }]),
                        ),
                        installed: await installed(),
                        canContinue: await canContinue(root),
                    })};\n${clientSrc}`,
                )
            }

            if (url.pathname === '/health') {
                return json(res, 200, { ok: true, name: 'laminator', root, project: config.project.name }, allow)
            }

            if (url.pathname === '/config') {
                return json(res, 200, {
                    project: config.project,
                    sourceRoots: config.sourceRoots,
                    styling: config.project.styling,
                    surfaceRoot: config.overrides?.surfaceRoot || '',
                    stats: config.stats,
                    agents: Object.fromEntries(
                        Object.entries(AGENTS).map(([id, s]) => [id, {
                            label: s.label,
                            supportsContinue: s.supportsContinue,
                            models: s.models || ['default'],
                            efforts: s.effortFlag ? s.efforts || [] : [],
                        }]),
                    ),
                    installed: await installed(),
                    canContinue: await canContinue(root),
                }, allow)
            }

            if (url.pathname === '/sessions') {
                return json(res, 200, { sessions: await sessions(root) }, allow)
            }

            if (url.pathname === '/rules' && req.method === 'POST') {
                const b = await body(req)
                const tokens = Array.isArray(b.tokens) ? b.tokens.slice(0, 40).map(String) : []
                return json(res, 200, { candidates: await candidates(root, config, tokens) }, allow)
            }

            if (url.pathname === '/css' && req.method === 'POST') {
                const b = await body(req)
                return json(res, 200, await edit(root, config, b), allow)
            }

            if (url.pathname === '/queue' && req.method === 'GET') {
                return json(res, 200, { annotations: await store.read(root), installed: await installed() }, allow)
            }

            if (url.pathname === '/queue' && req.method === 'POST') {
                const b = await body(req)
                switch (b.action) {
                    case 'add': {
                        if (!b.annotation?.comment?.trim()) return json(res, 400, { error: 'comment required' }, allow)
                        const item = await store.add(root, b.annotation, b.shot)
                        return json(res, 200, { ok: true, item, annotations: await store.read(root) }, allow)
                    }
                    case 'savings':
                        return json(res, 200, await store.ledger(root), allow)
                    case 'update': {
                        const item = await store.update(root, b.id, b.patch)
                        if (!item) return json(res, 404, { error: 'no such annotation' }, allow)
                        return json(res, 200, { ok: true, item, annotations: await store.read(root) }, allow)
                    }
                    case 'reply': {
                        const item = await store.reply(root, b.id, b.role, String(b.content ?? '').trim())
                        if (!item) return json(res, 404, { error: 'no such annotation' }, allow)
                        return json(res, 200, { ok: true, item }, allow)
                    }
                    case 'delete':
                        return json(res, 200, { ok: true, annotations: await store.remove(root, b.id) }, allow)
                    case 'clear':
                        await store.write(root, [])
                        return json(res, 200, { ok: true, annotations: [] }, allow)
                    case 'export': {
                        const list = await store.read(root)
                        if (!list.some(store.isOpen)) return json(res, 400, { error: 'nothing to export' }, allow)
                        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
                        const md = store.toMarkdown(list, config, { brief: b.brief })
                        const file = await store.writeExport(root, `review-${stamp}.md`, md)
                        await store.writeExport(
                            root,
                            `review-${stamp}.json`,
                            JSON.stringify({ version: '1.1', exportedAt: new Date().toISOString(), annotations: list }, null, 2),
                        )
                        // Before the launch, so the ledger is right even when no
                        // terminal opens.
                        const av = await store.avoided(root, list, writableStyles(config))
                        await store.ledger(root, {
                            at: new Date().toISOString(),
                            file,
                            annotations: list.length,
                            anchored: av.anchored,
                            screenshots: list.filter((a) => a.screenshot).length,
                            avoidedBytes: av.bytes,
                            suppliedBytes: Buffer.byteLength(md, 'utf8'),
                        })
                        const result =
                            b.launch === false
                                ? { ok: false, how: 'not requested' }
                                : await launch(root, {
                                      file,
                                      agent: b.agent ?? 'claude',
                                      model: b.model ?? '',
                                      effort: b.effort ?? '',
                                      target: b.target ?? 'new',
                                      commandFile: '.laminator/review-ui.md',
                                  })
                        return json(res, 200, {
                            ok: true, file, count: list.filter(store.isOpen).length, launch: result,
                        }, allow)
                    }
                    default:
                        return json(res, 400, { error: `unknown action "${b.action}"` }, allow)
                }
            }

            return json(res, 404, { error: 'no such endpoint' }, allow)
        } catch (e) {
            return json(res, 400, { error: e instanceof Error ? e.message : 'failed' }, allow)
        }
    })

    await new Promise((resolve, reject) => {
        server.once('error', reject)
        // 127.0.0.1 keeps it off the network.
        server.listen(port, '127.0.0.1', resolve)
    })
    if (!quiet) {
        console.log(`\n  laminator is watching ${config.project.name}`)
        console.log(`  http://127.0.0.1:${port}\n`)
    }
    return { server, port, token, config }
}
