// Handing the batch to a coding agent.
//
// WHAT CANNOT BE DONE, said first because the obvious expectation is exactly
// this: nothing can type into a terminal that is already running. There is no
// CLI for it in any of these agents. So the honest options are a fresh session,
// a new window that CONTINUES an existing conversation, or the clipboard —
// which is what "paste it into the terminal I already have" actually is.
//
// WHY A SCRIPT FILE ON WINDOWS. Three reasons, all discovered rather than
// assumed while building the version this came from:
//   1. `spawn('claude')` is ENOENT and `spawn('claude.cmd')` is EINVAL — Node
//      refuses a .cmd without a shell. Only `cmd /c` works.
//   2. `start` treats its first quoted argument as a WINDOW TITLE, and Node's
//      Windows argument quoting fights cmd's. Nesting a quoted prompt inside
//      `start` inside `cmd /c` is three layers of escaping to get wrong.
//   3. The file is inspectable and re-runnable. When a handoff does not open,
//      you can read exactly what was going to run and double-click it.

import { execFile, spawn } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { promisify } from 'util'

const run = promisify(execFile)

/**
 * The agents this can hand to.
 *
 * `resume` is Claude Code's own concept; the others get no such flag rather
 * than a guessed equivalent, because an unknown flag is an argument error at
 * the terminal rather than a graceful fallback.
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
        // No slash commands, so it is pointed at the same instructions BY PATH.
        // One source of truth, several readers.
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

/** Which agent CLIs exist here. Memoised: this is asked on every panel open and
 *  the answer changes about once a year. */
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

/** Live Claude Code conversations that `--resume` could be handed to. Not
 *  memoised — sessions start and stop constantly and a stale list offers a
 *  conversation that has gone. */
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
 * Returns rather than throws: a handoff that could not open is worth a message,
 * but it must never take the export down with it — the review file is already
 * on disk by the time this runs and is the thing that actually matters.
 */
export async function launch(root, { file, agent = 'claude', model = '', target = 'new', commandFile }) {
    const spec = AGENTS[agent]
    if (!spec) return { ok: false, how: `unknown agent "${agent}"` }
    if (target === 'copy') return { ok: false, how: 'copy only — nothing opened, by request' }

    const have = await installed()
    if (!have[agent]) {
        // Said plainly rather than attempted: spawning a missing command opens a
        // window that flashes an error and closes, which reads as a broken
        // button rather than as a missing CLI.
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
                    // Keeps the window up if the CLI exits at once, so the error
                    // is readable instead of flashing past.
                    'if errorlevel 1 pause',
                    '',
                ].join('\r\n'),
                'utf8',
            )
            // `start` needs an empty title argument before the target, or it
            // eats the target AS the title and opens a bare shell.
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

        // Linux has no single answer for "open a terminal". The Debian
        // alternative is tried and the result reported honestly rather than
        // guessing down a list of six emulators.
        spawn('x-terminal-emulator', ['-e', spec.command, ...flags, text], {
            cwd: root, detached: true, stdio: 'ignore',
        }).unref()
        return { ok: true, how: 'x-terminal-emulator' }
    } catch (e) {
        return { ok: false, how: e instanceof Error ? e.message : 'spawn failed' }
    }
}
