// What the picker turns into on the command line.
//
// This is invisible when it breaks: a wrong flag still opens a terminal, and
// the session just runs as a different model than the toolbar claimed.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AGENTS, handoffFlags } from '../src/server/launch.mjs'

describe('the prompt a terminal is opened on', () => {
    // `laminator init` only installs the slash command where the project
    // already has a `.claude/` directory. Sending `/laminator-review` anyway
    // opens a terminal that answers "Unknown command" and nothing else.
    // To break it: make claude's prompt ignore its third argument.
    const FILE = '.laminator/review-2026-01-01.md'
    const CMD = '.laminator/review-ui.md'

    test('uses the slash command when one was installed', () => {
        assert.equal(AGENTS.claude.prompt(FILE, CMD, true), `/laminator-review ${FILE}`)
    })

    test('falls back to the path when one was not', () => {
        const p = AGENTS.claude.prompt(FILE, CMD, false)
        assert.ok(!p.startsWith('/'), `still a slash command: ${p}`)
        assert.ok(p.includes(CMD) && p.includes(FILE), p)
    })

    test('the other agents never get a slash command', () => {
        for (const id of ['codex', 'gemini']) {
            const p = AGENTS[id].prompt(FILE, CMD, true)
            assert.ok(!p.startsWith('/'), `${id}: ${p}`)
        }
    })
})

describe('handoffFlags()', () => {
    // The one that matters. A pinned settings.json may say "opus[1m]", and
    // --model opus selects the plain alias instead, quietly dropping the
    // 1M-context build. Emitting nothing is what lets the file win.
    // To break it: drop the `!== 'default'` guard.
    test('default contributes no flag at all', () => {
        assert.deepEqual(handoffFlags('claude', { model: 'default', effort: 'default' }), [])
        assert.deepEqual(handoffFlags('claude', {}), [])
    })

    test('a real choice reaches the terminal', () => {
        assert.deepEqual(
            handoffFlags('claude', { model: 'opus', effort: 'high' }),
            ['--model', 'opus', '--effort', 'high'],
        )
    })

    // opus is not a model on the codex or gemini CLIs; it is a typo that
    // reaches a terminal and fails there.
    // To break it: stop checking `known.includes(model)`.
    test('a model the agent does not have is dropped', () => {
        assert.deepEqual(handoffFlags('claude', { model: 'not-a-model' }), [])
        assert.deepEqual(handoffFlags('codex', { model: 'opus' }), [])
    })

    // There is no honest translation of an effort onto a CLI without one.
    test('effort is dropped for agents with no effort flag', () => {
        assert.deepEqual(handoffFlags('codex', { effort: 'high' }), [])
        assert.deepEqual(handoffFlags('gemini', { effort: 'max' }), [])
    })

    // --continue and --resume are Claude Code's own concepts. An unknown flag
    // is an argument error at the terminal, so the others never get them.
    test('resume flags are Claude-only', () => {
        assert.deepEqual(handoffFlags('claude', { target: 'continue' }), ['--continue'])
        assert.deepEqual(handoffFlags('claude', { target: 'session:abc12345' }), ['--resume', 'abc12345'])
        assert.deepEqual(handoffFlags('codex', { target: 'continue' }), [])
    })

    test('an unknown agent asks for nothing', () => {
        assert.deepEqual(handoffFlags('nope', { model: 'opus' }), [])
    })

    // These values are attacker-reachable: any local process can POST an
    // export, and a page on a localhost origin can read the token from
    // /client.js and then do the same. On Windows they land inside a .cmd
    // file and on macOS inside a shell script, both of which read `&` as
    // syntax. Allowlisted rather than escaped, so there is nothing to quote.
    //
    // To break it: drop `(spec.efforts || []).includes(effort)`, or the
    // /^[A-Za-z0-9_-]{1,64}$/ test on the session id.
    describe('values that reach a command line', () => {
        // Stated as what is allowed rather than what is banned. A blocklist
        // of metacharacters is one forgotten character away from useless.
        const SAFE = /^[\w.:=-]+$/

        for (const [why, opts] of [
            ['effort with a chained command', { effort: 'high & calc.exe' }],
            ['effort breaking out of quotes', { effort: 'high" & calc.exe & "' }],
            ['a session id with a command', { target: 'session:abc & calc.exe' }],
            ['a session id breaking out', { target: 'session:a" && calc.exe && "' }],
            ['a model with a command', { model: 'opus & calc.exe' }],
        ]) {
            test(why + ' is dropped', () => {
                for (const f of handoffFlags('claude', opts)) {
                    assert.ok(SAFE.test(f), `unsafe value reached argv: ${JSON.stringify(f)}`)
                }
            })
        }

        // The guard above is worthless if it also rejects the real values.
        test('but the real values still get through', () => {
            assert.deepEqual(handoffFlags('claude', { effort: 'max' }), ['--effort', 'max'])
            assert.deepEqual(handoffFlags('claude', { model: 'haiku' }), ['--model', 'haiku'])
            assert.deepEqual(
                handoffFlags('claude', { target: 'session:06ff5f66-15b6-4e7e-be61-b1aeb8cee815' }),
                ['--resume', '06ff5f66-15b6-4e7e-be61-b1aeb8cee815'],
            )
        })
    })
})
