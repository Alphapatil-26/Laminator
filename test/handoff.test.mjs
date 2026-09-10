// What the picker turns into on the command line.
//
// This is invisible when it breaks: a wrong flag still opens a terminal, and
// the session just runs as a different model than the toolbar claimed.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { handoffFlags } from '../src/server/launch.mjs'

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
})
