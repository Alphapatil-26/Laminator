// Working out what a project is: stylesheets, framework, where the code lives.
//
// Everything here reports what it found and says so when it found nothing. A
// scanner that quietly substitutes a default fails later, somewhere else, for
// reasons nobody can trace back to the scan.

import { promises as fs } from 'fs'
import path from 'path'

/** Directories never worth walking: generated, vendored, or enormous. */
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
    'dist', 'build', 'out', 'coverage', 'vendor', 'target', '__pycache__',
    '.venv', 'venv', '.idea', '.vscode', 'tmp', 'temp', '.laminator', '.inspector',
])

const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.pcss', '.postcss'])
const CODE_EXT = new Set(['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.astro', '.mjs'])

/** Generated or compiled CSS that must never be offered as editable. */
const GENERATED = [
    /\.min\.css$/i,
    /(^|[\\/])(dist|build|out|public|static|assets)[\\/].*\.css$/i,
    // A CSS module's class names are hashed at build time, so a selector seen
    // in the browser cannot be traced back here. An anchor into one would look
    // right and point nowhere.
    /\.module\.(css|scss|sass|less)$/i,
]

export const isGenerated = (rel) => GENERATED.some((re) => re.test(rel))

/**
 * Walk a project, with a ceiling on how much.
 *
 * A scan that grinds through a monorepo for two minutes gets cancelled by the
 * person waiting. When the ceiling is hit the caller is told, because a
 * half-indexed project answers "no rule found" exactly like a complete one.
 */
export async function walk(root, { maxFiles = 20000, maxDepth = 12 } = {}) {
    const files = []
    let truncated = false

    async function rec(dir, depth) {
        if (truncated || depth > maxDepth) return
        let entries
        try {
            entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const e of entries) {
            if (files.length >= maxFiles) {
                truncated = true
                return
            }
            if (e.name.startsWith('.') && e.name !== '.storybook') {
                if (SKIP_DIRS.has(e.name)) continue
                if (e.isDirectory()) continue
            }
            const full = path.join(dir, e.name)
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue
                await rec(full, depth + 1)
            } else if (e.isFile()) {
                files.push(path.relative(root, full).split(path.sep).join('/'))
            }
        }
    }

    await rec(root, 0)
    return { files, truncated }
}

async function readJSON(file) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
        return null
    }
}

/**
 * Which framework and styling approach this project uses.
 *
 * Read from package.json. File extensions lie: a repo can hold one .vue file in
 * a docs folder and not be a Vue app, and this answer shapes what the review
 * command tells an agent to do.
 */
export async function detect(root, files) {
    const pkg = (await readJSON(path.join(root, 'package.json'))) ?? {}
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    const has = (n) => Object.prototype.hasOwnProperty.call(deps, n)

    const frameworks = []
    if (has('next')) frameworks.push('next')
    if (has('react') && !has('next')) frameworks.push('react')
    if (has('vue') || has('nuxt')) frameworks.push('vue')
    if (has('svelte') || has('@sveltejs/kit')) frameworks.push('svelte')
    if (has('astro')) frameworks.push('astro')
    if (has('vite') ) frameworks.push('vite')
    if (has('@angular/core')) frameworks.push('angular')

    const styling = []
    // Also from the config file: v4 projects often carry only an @import line.
    const tailwindCfg = files.find((f) => /^tailwind\.config\.[cm]?[jt]s$/.test(f))
    if (has('tailwindcss') || tailwindCfg) styling.push('tailwind')
    if (has('styled-components')) styling.push('styled-components')
    if (has('@emotion/react') || has('@emotion/styled')) styling.push('emotion')
    if (files.some((f) => /\.module\.(css|scss|sass|less)$/.test(f))) styling.push('css-modules')
    if (files.some((f) => STYLE_EXT.has(path.extname(f)) && !isGenerated(f))) styling.push('stylesheets')

    return {
        name: pkg.name ?? path.basename(root),
        frameworks,
        styling,
        scripts: {
            dev: pkg.scripts?.dev ?? pkg.scripts?.start ?? null,
            test: pkg.scripts?.test ?? null,
            lint: pkg.scripts?.lint ?? null,
            typecheck: pkg.scripts?.typecheck ?? (has('typescript') ? 'tsc --noEmit' : null),
        },
        packageManager: files.includes('pnpm-lock.yaml')
            ? 'pnpm'
            : files.includes('yarn.lock')
              ? 'yarn'
              : files.includes('bun.lockb')
                ? 'bun'
                : 'npm',
    }
}

/** The stylesheets worth indexing, and the ones left out. */
export function classifyStyles(files) {
    const editable = []
    const excluded = []
    for (const f of files) {
        if (!STYLE_EXT.has(path.extname(f))) continue
        if (isGenerated(f)) {
            excluded.push({
                file: f,
                why: /\.module\./.test(f)
                    ? 'CSS module — class names are hashed at build time, so a selector seen in the browser cannot be traced back here'
                    : 'generated or compiled output',
            })
            continue
        }
        editable.push(f)
    }
    return { editable, excluded }
}

/** Where components live. Tailwind findings have no stylesheet to point at, so
 *  the agent gets these directories to search instead. */
export function sourceRoots(files) {
    const counts = new Map()
    for (const f of files) {
        if (!CODE_EXT.has(path.extname(f))) continue
        const top = f.split('/').slice(0, 2).join('/')
        counts.set(top, (counts.get(top) ?? 0) + 1)
    }
    return [...counts.entries()]
        .filter(([, n]) => n >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([dir, n]) => ({ dir, files: n }))
}
