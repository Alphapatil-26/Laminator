#!/usr/bin/env node
// laminator init     scan the project and print the script tag
// laminator          serve, scanning first if it never has
// laminator scan     re-read the project after moving CSS around
// laminator doctor   what it found, and what it could not

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { readConfig, scan, write } from '../src/scan/index.mjs'
import { serve } from '../src/server/index.mjs'
import { installed } from '../src/server/launch.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const cmd = args.find((a) => !a.startsWith('-')) ?? 'serve'
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : fallback
}
const root = path.resolve(flag('root', process.cwd()))
const port = Number(flag('port', 7317))

// Escaped, since a raw control byte is invisible in a diff.
const E = '['
const b = (s) => E + '1m' + s + E + '0m'
const dim = (s) => E + '2m' + s + E + '0m'
const ok = (s) => E + '32m' + s + E + '0m'
const warn = (s) => E + '33m' + s + E + '0m'

function snippet(port) {
    return `<script src="http://127.0.0.1:${port}/client.js"></script>`
}

async function doScan(quiet = false) {
    const t0 = Date.now()
    const result = await scan(root, { onProgress: quiet ? undefined : (m) => process.stdout.write(dim(`  ${m}\r`)) })
    await write(root, result)
    if (!quiet) process.stdout.write(' '.repeat(60) + '\r')
    return result
}

function report(config) {
    const s = config.stats
    const p = config.project
    console.log(`\n  ${b(p.name)}  ${dim(config.root)}`)
    console.log(`  framework   ${p.frameworks.join(', ') || warn('none detected')}`)
    console.log(`  styling     ${p.styling.join(', ') || warn('none detected')}`)
    console.log(`  scanned     ${s.files} files in ${s.tookMs}ms`)
    console.log(`  stylesheets ${ok(s.stylesheets)} editable, ${s.rules} rules, ${s.tokens} selectors indexed`)
    if (config.styles.excluded.length) {
        console.log(`  excluded    ${config.styles.excluded.length} ${dim('(see .laminator/config.json for why)')}`)
    }
    if (s.filesTruncated) {
        console.log(warn(`  NOTE        the walk hit its file ceiling — some of the project was not scanned`))
    }
    if (!s.stylesheets) {
        console.log(warn(`\n  No authored stylesheets found.`))
        console.log(
            dim(
                `  laminator can still capture elements, components and computed styles —\n` +
                    `  it just cannot give you a file:line for a CSS rule. If this project\n` +
                    `  does have stylesheets, add them to overrides.includeStyles in\n` +
                    `  .laminator/config.json and re-run \`laminator scan\`.`,
            ),
        )
    }
}

async function writeCommandFile(config) {
    const tpl = await fs.readFile(path.join(HERE, '..', 'templates', 'review-ui.md'), 'utf8')
    const filled = tpl
        .replaceAll('{{PROJECT}}', config.project.name)
        .replaceAll('{{PORT}}', String(port))
        .replaceAll('{{FRAMEWORKS}}', config.project.frameworks.join(', ') || 'unknown')
        .replaceAll('{{STYLING}}', config.project.styling.join(', ') || 'unknown')
        .replaceAll('{{TEST}}', config.project.scripts.test ?? '(no test script found)')
        .replaceAll('{{TYPECHECK}}', config.project.scripts.typecheck ?? '(no typecheck script found)')
        .replaceAll('{{LINT}}', config.project.scripts.lint ?? '(no lint script found)')
        .replaceAll(
            '{{SOURCE_ROOTS}}',
            config.sourceRoots.map((r) => `\`${r.dir}\` (${r.files} files)`).join(', ') || 'not detected',
        )

    await fs.writeFile(path.join(root, '.laminator', 'review-ui.md'), filled, 'utf8')

    // Only if .claude already exists. Creating it would be this tool picking
    // your agent for you.
    const claudeDir = path.join(root, '.claude', 'commands')
    try {
        await fs.access(path.join(root, '.claude'))
        await fs.mkdir(claudeDir, { recursive: true })
        await fs.writeFile(path.join(claudeDir, 'laminator-review.md'), filled, 'utf8')
        return true
    } catch {
        return false
    }
}

try {
    if (cmd === 'init') {
        console.log(`\n  scanning ${dim(root)}`)
        const result = await doScan()
        report(result.config)
        const asSlash = await writeCommandFile(result.config)
        console.log(`\n  wrote ${ok('.laminator/')} ${dim('(config, selector index, review command — all gitignored)')}`)
        if (asSlash) console.log(`  wrote ${ok('.claude/commands/laminator-review.md')} ${dim('(slash command)')}`)

        console.log(`\n  ${b('Add this one line to your app, in development only:')}\n`)
        console.log(`      ${snippet(port)}\n`)
        console.log(dim('  Then run `laminator` and open your app. Ctrl/Cmd+Shift+F toggles the toolbar.'))
        const have = await installed()
        const names = Object.entries(have).filter(([, v]) => v).map(([k]) => k)
        console.log(
            names.length
                ? dim(`  Agents found on this machine: ${names.join(', ')}`)
                : warn('  No agent CLI found — Send will still write the review file and copy the prompt.'),
        )
        console.log()
    } else if (cmd === 'scan') {
        const result = await doScan()
        report(result.config)
        await writeCommandFile(result.config)
        console.log(`\n  ${ok('re-scanned')}\n`)
    } else if (cmd === 'doctor') {
        const config = await readConfig(root)
        if (!config) {
            console.log(warn('\n  No scan yet. Run `laminator init`.\n'))
            process.exit(1)
        }
        report(config)
        console.log(`\n  scanned at  ${config.scannedAt}`)
        console.log(`  agents      ${JSON.stringify(await installed())}`)
        console.log(`  snippet     ${snippet(port)}\n`)
    } else if (cmd === 'serve' || cmd === undefined) {
        let config = await readConfig(root)
        if (!config) {
            console.log(dim('\n  no scan found — scanning first'))
            config = (await doScan()).config
            await writeCommandFile(config)
            report(config)
        }
        await serve(root, { port })
        console.log(dim(`  add to your app:  ${snippet(port)}`))
        console.log(dim('  Ctrl+C to stop\n'))
    } else {
        console.log(`\n  unknown command "${cmd}"\n`)
        console.log('  laminator init | serve | scan | doctor  [--root DIR] [--port N]\n')
        process.exit(1)
    }
} catch (e) {
    console.error(`\n  ${warn('laminator failed:')} ${e instanceof Error ? e.message : e}\n`)
    process.exit(1)
}
