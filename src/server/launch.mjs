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
 * Only Claude Code has a model list and an effort flag here. Neither codex nor
 * gemini was installed to read one from, and an invented model id looks
 * authoritative in a dropdown and then fails at the terminal, so they offer
 * `default` alone and their Effort row is hidden rather than shown and ignored.
 */
export const AGENTS = {
    claude: {
        label: 'Claude Code',
        command: 'claude',
        modelFlag: '--model',
        // Verified against `claude --help`: aliases or full names.
        models: ['default', 'opus', 'sonnet', 'haiku', 'fable'],
        effortFlag: '--effort',
        efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
        supportsContinue: true,
        // Slash commands are a Claude Code feature: a file in `.claude/commands`.
        // `laminator init` only writes one when the project already has a
        // `.claude/` directory, so on a project without one the fallback is the
        // same path-based instruction the other agents get. Sending
        // `/laminator-review` regardless produces "Unknown command" in a fresh
        // terminal, which reads as the tool being broken.
        prompt: (file, cmdFile, hasSlash) => (hasSlash
            ? `/laminator-review ${file}`
            : `Read ${cmdFile} and follow it exactly for the review file ${file}.`),
    },
    codex: {
        label: 'OpenAI Codex',
        command: 'codex',
        modelFlag: '--model',
        models: ['default'],
        effortFlag: null,
        supportsContinue: false,
        // No slash commands, so it gets the same instructions by path.
        prompt: (file, cmdFile) => `Read ${cmdFile} and follow it exactly for the review file ${file}.`,
    },
    gemini: {
        label: 'Gemini CLI',
        command: 'gemini',
        modelFlag: '--model',
        models: ['default'],
        effortFlag: null,
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
/**
 * Whether `--continue` has anything to continue in this folder.
 *
 * Claude Code keys stored conversations by cwd, under
 * `~/.claude/projects/<cwd with every non-alphanumeric turned into a dash>`.
 * Offering Continue last where that folder is empty produces a window that
 * prints "No conversation found to continue" and closes, which reads as the
 * handoff being broken.
 *
 * `sessions()` cannot answer this: it lists LIVE interactive sessions, not
 * history.
 *
 * Unknown is treated as yes. If this encoding ever changes, the cost of
 * guessing wrong should be an option that fails loudly, not one that is
 * missing with no explanation.
 */
export async function canContinue(cwd) {
    const home = process.env.USERPROFILE || process.env.HOME
    if (!home) return true
    const root = path.join(home, '.claude', 'projects')
    let entries
    try { entries = await fs.readdir(root) } catch { return true }

    const want = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
    // Windows spells the drive letter either way depending on how cwd reached
    // us, and the directory keeps whichever was used.
    const dir = entries.find((e) => e.toLowerCase() === want)
    if (!dir) return false
    try {
        return (await fs.readdir(path.join(root, dir))).some((f) => f.endsWith('.jsonl'))
    } catch { return false }
}

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

/** Whether `laminator init` was able to install the slash command here. */
async function hasSlashCommand(root) {
    try {
        await fs.access(path.join(root, '.claude', 'commands', 'laminator-review.md'))
        return true
    } catch { return false }
}

const flatten = (s) => String(s).replace(/["\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Single-quote for /bin/sh. The only character that matters inside single
 *  quotes is the single quote itself, which has to be closed, escaped and
 *  reopened. */
const shq = (s) => `'${String(s).replace(/'/g, `'\''`)}'`

/**
 * Open an agent on this review file.
 *
 * Returns instead of throwing. The review file is already on disk by the time
 * this runs, so a terminal that would not open should cost the handoff and
 * nothing else.
 */
/**
 * The flags a choice turns into.
 *
 * `default` contributes nothing, and that is the whole point. A pinned
 * `~/.claude/settings.json` may say `"model": "opus[1m]"`; passing `--model
 * opus` selects the plain alias instead and silently drops the 1M-context
 * build. Emitting no flag lets the session inherit the settings file, including
 * settings that change later without this code knowing.
 *
 * An effort asked of an agent with no effort flag is dropped rather than
 * mapped onto something that looks similar.
 */
export function handoffFlags(agent, { model = '', effort = '', target = 'new' } = {}) {
    const spec = AGENTS[agent]
    if (!spec) return []
    const flags = []
    // Everything here is allowlisted rather than escaped. On Windows these end
    // up inside a .cmd file and on macOS inside a script, both of which read
    // `&` and `|` as syntax; a value that cannot contain them cannot be quoted
    // wrongly later. `model` was already checked this way. `effort` and the
    // session id were not, and `--effort "high & calc.exe"` was a real hole.
    if (model && model !== 'default' && (spec.models || ['default']).includes(model)) {
        flags.push(spec.modelFlag, model)
    }
    if (effort && effort !== 'default' && spec.effortFlag && (spec.efforts || []).includes(effort)) {
        flags.push(spec.effortFlag, effort)
    }
    if (spec.supportsContinue) {
        if (target === 'continue') flags.push('--continue')
        else if (target.startsWith('session:')) {
            const id = target.slice(8)
            // Claude Code session ids are uuids. Anything else is not one.
            if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) flags.push('--resume', id)
        }
    }
    return flags
}

export async function launch(root, { file, agent = 'claude', model = '', effort = '', target = 'new', commandFile }) {
    const spec = AGENTS[agent]
    if (!spec) return { ok: false, how: `unknown agent "${agent}"` }
    if (target === 'copy') return { ok: false, how: 'copy only — nothing opened, by request' }

    const have = await installed()
    if (!have[agent]) {
        // Spawning a missing command opens a window that flashes an error and
        // closes, which reads as a broken button.
        return { ok: false, how: `${spec.command} is not installed` }
    }

    const flags = handoffFlags(agent, { model, effort, target })
    const text = flatten(spec.prompt(file, commandFile, await hasSlashCommand(root)))

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
            // Write the script, then tell Terminal to run that one path. The
            // previous version pasted the command, its flags and the prompt
            // into a `do script "..."` string, where a quote in any of them
            // escaped into AppleScript and then into the shell.
            const script = path.join(root, '.laminator', 'launch-review.sh')
            await fs.mkdir(path.dirname(script), { recursive: true })
            await fs.writeFile(
                script,
                ['#!/bin/sh', `cd ${shq(root)} || exit 1`, `exec ${[spec.command, ...flags, text].map(shq).join(' ')}`, ''].join('\n'),
                'utf8',
            )
            await fs.chmod(script, 0o755)
            spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`], {
                detached: true, stdio: 'ignore',
            }).unref()
            return { ok: true, how: 'Terminal.app', script: '.laminator/launch-review.sh' }
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
