import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { indexRules, rules, tokens } from '../src/scan/css.mjs'

// The parser is the whole tool's foundation: every anchor laminator ever reports
// is a line number this produced. A wrong line does not throw — it sends someone
// to the wrong part of a real file, which reads as the tool being useless rather
// than as the tool being broken.

describe('rules()', () => {
    it('reports the line the rule STARTS on', () => {
        const css = ['.a { color: red }', '', '.b {', '  color: blue;', '}'].join('\n')
        const r = rules(css)
        assert.equal(r.length, 2)
        assert.deepEqual(r.map((x) => [x.prelude, x.line]), [['.a', 1], ['.b', 3]])
    })

    // THE ONE THAT MATTERS MOST. Comments are where a naive parser loses count,
    // and every later anchor in the file is then wrong by the same amount.
    //
    // NEGATIVE CONTROL (run 2026-09-09): make `decomment` return
    // `src.replace(/\/\*[\s\S]*?\*\//g, '')` — dropping the newlines instead of
    // preserving them — and this goes red: `.after` is reported at line 2.
    it('keeps line numbers true across multi-line comments', () => {
        const css = ['/* one', '   two', '   three */', '.after { color: red }'].join('\n')
        assert.deepEqual(rules(css).map((x) => [x.prelude, x.line]), [['.after', 4]])
    })

    it('records the at-rules a rule sits inside', () => {
        const css = ['@media (min-width: 40em) {', '  .wide { display: grid }', '}'].join('\n')
        const [r] = rules(css)
        assert.equal(r.prelude, '.wide')
        assert.equal(r.line, 2)
        assert.deepEqual(r.at, ['@media (min-width: 40em)'])
    })

    // NEGATIVE CONTROL (run 2026-09-09): remove `@keyframes` from the OPAQUE
    // pattern and this goes red — `from`, `to` and `50%` are parsed as
    // selectors and land in the index as rules that can never match anything.
    it('does not mistake keyframe steps for selectors', () => {
        const css = [
            '@keyframes spin { from { transform: none } 50% { opacity: .5 } to { opacity: 1 } }',
            '.real { color: red }',
        ].join('\n')
        assert.deepEqual(rules(css).map((x) => x.prelude), ['.real'])
    })

    it('skips @font-face and @property bodies too', () => {
        const css = '@font-face { font-family: X; src: url(a.woff2) }\n.real { color: red }'
        assert.deepEqual(rules(css).map((x) => x.prelude), ['.real'])
    })

    it('is not confused by braces or semicolons inside strings', () => {
        const css = `.a { content: "} not the end;" }\n.b { color: red }`
        assert.deepEqual(rules(css).map((x) => x.prelude), ['.a', '.b'])
    })

    it('ignores @import and @charset statements', () => {
        const css = `@charset "utf-8";\n@import url("other.css");\n.a { color: red }`
        assert.deepEqual(rules(css).map((x) => [x.prelude, x.line]), [['.a', 3]])
    })

    it('finds nested rules and keeps the outer one', () => {
        const css = ['.card {', '  color: red;', '  &:hover { color: blue }', '}'].join('\n')
        const got = rules(css).map((x) => x.prelude)
        assert.ok(got.includes('.card'), got.join('|'))
        assert.ok(got.includes('&:hover'), got.join('|'))
    })

    it('survives an unclosed rule instead of throwing', () => {
        assert.doesNotThrow(() => rules('.a { color: red'))
    })
})

describe('tokens()', () => {
    it('indexes classes, ids and attributes', () => {
        assert.deepEqual(tokens('.card .title#main[data-open]').sort(), ['#main', '.card', '.title', '[data-open]'])
    })

    // A bare tag matches half a page. Indexing `div` makes every lookup return
    // everything, which is the same as having no index at all.
    //
    // NEGATIVE CONTROL (run 2026-09-09): add a `\b[a-z][\w-]*\b` pattern to
    // `tokens` and this goes red — `div` and `p` enter the index.
    it('does NOT index bare tag selectors', () => {
        assert.deepEqual(tokens('div p'), [])
        assert.deepEqual(tokens('button.cta'), ['.cta'])
    })

    it('deduplicates a token repeated in one prelude', () => {
        assert.deepEqual(tokens('.a .b .a'), ['.a', '.b'])
    })
})

describe('indexRules()', () => {
    it('maps every token to every rule that mentions it', () => {
        const { index, count } = indexRules([
            { file: 'a.css', src: '.x { color: red }\n.x:hover { color: blue }' },
            { file: 'b.css', src: '.y .x { color: green }' },
        ])
        assert.equal(count, 3)
        assert.equal(index.get('.x').length, 3)
        assert.equal(index.get('.y').length, 1)
        assert.deepEqual(
            index.get('.x').map((r) => `${r.file}:${r.line}`),
            ['a.css:1', 'a.css:2', 'b.css:1'],
        )
    })

    it('returns nothing for a token nobody styles', () => {
        const { index } = indexRules([{ file: 'a.css', src: '.x { color: red }' }])
        assert.equal(index.get('.nope'), undefined)
    })
})
