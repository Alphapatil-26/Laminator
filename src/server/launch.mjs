// Handing the batch to a coding agent.
//
// Nothing can type into a terminal that is already running. No agent CLI offers
// it, so the options are a fresh session, a new window carrying an existing
// conversation, or the clipboard.
//
// Windows writes a .cmd file and starts that, for three reasons found the hard
// way:
//   1. spawn('claude') is ENOENT and spawn('claude.cmd') is EINVAL, because
//      Node refuses a .cmd without a shell. Only `cmd /c` works.
//   2. `start` treats its first quoted argument as a window title, and Node's
//      Windows quoting fights cmd's. A quoted prompt inside `start` inside
//      `cmd /c` is three layers of escaping to get wrong.
//   3. The file can be read and double-clicked when a handoff does not open.

import { execFile, spawn } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { promisify } from 'util'

const run = promisify(execFile)

/**
 * The agents this can hand to.
 *
 * `resume` is Claude Code's own idea. The others get no equivalent flag, since
 * a guessed one is an argument error at the terminal.
 *
 * TODO: codex and gemini have no model list. Neither CLI was installed when this
 * was written, and an invented model id looks authoritative in a dropdown and
 * then fails at the terminal. Read their --help and fill these in.
 */
export const AGENTS = {
    claude: {
        label: 'Claude Code',
        command: 'claude',
        modelFlag: '--model',
        supportsContinue: true,
        // Slash commands are a Claude Code feature: a file in `.claude/commands`.
        prompt: (file) => `/laminator-review ${file}`,
    },
    codex: {
        label: 'OpenAI Codex',
        command: 'codex',
        modelFlag: '--model',
        supportsContinue: false,
        // No slash commands, so it gets the same instructions by path.
        prompt: (file, cmdFile) => `Read ${cmdFile} and follow it exactly for the review file ${file}.`,
    },
    gemini: {
        label: 'Gemini CLI',
        command: 'gemini',
        modelFlag: '--model',
        supportsContinue: false,
        prompt: (file, cmdFile) => `Read ${cmdFile} and follow it exactly for the review file ${file}.`,
    },
}

let installedCache = null

/** Which agent CLIs exist here. Memoised; the answer changes about once a year
 *  and this is asked on every panel open. */
export async function installed() {
    if (installedCache) return installedCache
    const probe = process.platform === 'win32' ? 'where' : 'which'
    const entries = await Promise.all(
        Object.entries(AGENTS).map(async ([id, spec]) => {
            try {
                await run(probe, [spec.command], { timeout: 3000, windowsHide: true })
                return [id, true]
            } catch {
                return [id, false]
            }
        }),
    )
    installedCache = Object.fromEntries(entries)
    return installedCache
}

/** Live conversations `--resume` could be handed to. Not memoised, because a
 *  stale list offers a session that has already ended. */
export async function sessions(cwd) {
    try {
        const { stdout } = await run('claude', ['agents', '--json'], {
            cwd,
            timeout: 8000,
            windowsHide: true,
            shell: process.platform === 'win32',
        })
        const raw = JSON.parse(stdout)
        if (!Array.isArray(raw)) return []
        return raw
            .filter((r) => r && typeof r.sessionId === 'string')
            .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
            .slice(0, 8)
            .map((r) => ({ sessionId: r.sessionId, name: r.name ?? null, startedAt: r.startedAt ?? 0 }))
    } catch {
        return []
    }
}

const flatten = (s) => String(s).replace(/["\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Open an agent on this review file.
 *
 * Returns instead of throwing. The review file is already on disk by the time
 * this runs, so a terminal that would not open should cost the handoff and
 * nothing else.
 */
export async function launch(root, { file, agent = 'claude', model = '', target = 'new', commandFile }) {
    const spec = AGENTS[agent]
    if (!spec) return { ok: false, how: `unknown agent "${agent}"` }
    if (target === 'copy') return { ok: false, how: 'copy only — nothing opened, by request' }

    const have = await installed()
    if (!have[agent]) {
        // Spawning a missing command opens a window that flashes an error and
        // closes, which reads as a broken button.
        return { ok: false, how: `${spec.command} is not installed` }
    }

    const flags = []
    if (model && model !== 'default') flags.push(spec.modelFlag, model)
    if (spec.supportsContinue) {
        if (target === 'continue') flags.push('--continue')
        else if (target.startsWith('session:')) flags.push('--resume', target.slice(8))
    }
    const text = flatten(spec.prompt(file, commandFile))

    try {
        if (process.platform === 'win32') {
            const script = path.join(root, '.laminator', 'launch-review.cmd')
            await fs.mkdir(path.dirname(script), { recursive: true })
            await fs.writeFile(
                script,
                [
                    '@echo off',
                    `title ${spec.label} - UI review`,
                    `cd /d "${root}"`,
                    `${spec.command} ${flags.join(' ')}${flags.length ? ' ' : ''}"${text}"`,
                    // Keeps the window up so an error is readable.
                    'if errorlevel 1 pause',
                    '',
                ].join('\r\n'),
                'utf8',
            )
            // `start` needs an empty title first, or it takes the target as the
            // title and opens a bare shell.
            spawn('cmd.exe', ['/c', 'start', '', script], {
                cwd: root, detached: true, stdio: 'ignore', windowsHide: false,
            }).unref()
            return { ok: true, how: 'new terminal', script: '.laminator/launch-review.cmd' }
        }

        if (process.platform === 'darwin') {
            const inner = [spec.command, ...flags, JSON.stringify(text)].join(' ')
            spawn('osascript', ['-e', `tell application "Terminal" to do script "cd ${JSON.stringify(root)} && ${inner}"`], {
                detached: true, stdio: 'ignore',
            }).unref()
            return { ok: true, how: 'Terminal.app' }
        }

        // Linux has no single answer for "open a terminal". Try the Debian
        // alternative and report what happened.
        spawn('x-terminal-emulator', ['-e', spec.command, ...flags, text], {
            cwd: root, detached: true, stdio: 'ignore',
        }).unref()
        return { ok: true, how: 'x-terminal-emulator' }
    } catch (e) {
        return { ok: false, how: e instanceof Error ? e.message : 'spawn failed' }
    }
}
