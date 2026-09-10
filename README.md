<h1 align="center">Laminator</h1>
<p align="center"><b>Visual feedback. For agents.</b></p>
<p align="center">
  Point at anything in your running app and hand a coding agent the
  <b>file and line that paints it</b>.<br>
  Entirely local · zero dependencies · works on any stack.
</p>
<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#using-it">Usage</a> ·
  <a href="SETUP.md">Setup &amp; troubleshooting</a> ·
  <a href="AGENTS.md">For your agent</a> ·
  <a href="https://alphapatil-26.github.io/Laminator/">Docs</a>
</p>

---

You click a heading that looks wrong, type *"this is too tight"*, and press Send.
Your agent opens with a review file that already says `styles/cards.css:3`, what
the rule currently declares, how many other elements that rule moves, and what
the element's computed styles actually resolved to. There is no screenshot to
describe and no "which file is that in?".

Everything is local: one Node process on `127.0.0.1`, zero npm dependencies, no
account, no telemetry, and no network call to anywhere but your own machine.

---

## Requirements

- Node 18+
- A project with a dev server. React, Vue, Svelte, Rails, Django, a static HTML
  file; Laminator does not care.
- Optionally an agent CLI: `claude`, `codex`, or `gemini`. Without one, Send
  still writes the review file and copies the prompt.

## Install

```bash
npm install --save-dev laminator
```

Or run it without installing:

```bash
npx laminator init
```

## Quick start

**1. Scan your project.** From the project root:

```bash
npx laminator init
```

```
  bramble-coffee  /Users/you/code/bramble
  framework   vite
  styling     stylesheets
  scanned     412 files in 38ms
  stylesheets 6 editable, 340 rules, 289 selectors indexed

  Add this one line to your app, in development only:

      <script src="http://127.0.0.1:7317/client.js"></script>
```

**2. Add that one line** to your app's HTML, in development only.

<details>
<summary>Where that line goes, per stack</summary>

| Stack | Where |
| --- | --- |
| Static HTML | before `</body>` |
| Vite | in `index.html`, before `</body>` |
| Next.js (App Router) | in `app/layout.tsx`: `{process.env.NODE_ENV === 'development' && <script src="http://127.0.0.1:7317/client.js" />}` |
| Next.js (Pages) | same, in `pages/_document.tsx` |
| Nuxt | `app.vue`, or `nitro.devHandlers` |
| Rails | `app/views/layouts/application.html.erb`, inside `<% if Rails.env.development? %>` |
| Django | your base template, inside `{% if debug %}` |
| SvelteKit | `src/app.html`, before `%sveltekit.body%`'s closing div |

Keep the guard. This script talks to a server that can edit your CSS, and it has
no business in a production bundle.
</details>

**3. Run it** and open your app:

```bash
npx laminator
```

Press **Ctrl/Cmd + Shift + F** in the browser. The toolbar appears bottom-right.

---

## Using it

| | Key | |
| --- | --- | --- |
| **Toolbar** | `Ctrl/Cmd+Shift+F` | show / hide |
| **Pick** | `E` | click one element |
| **Text** | `T` | select copy, and the exact words are captured |
| **Multi** | `M` | click several, press `M` again to comment on them together |
| **Area** | `A` | drag a region, and get the container plus everything in it |
| **Freeze** | `P` | pause every animation to annotate one frame |
| **Shots** | | attach a real screenshot, cropped with 48px of surroundings |
| **Save** | `Ctrl/Cmd+Enter` | |
| **Esc** | | closes the box, then the selection, then the mode, then the toolbar |

The comment box also takes dictation where the browser supports it. Any finding
whose rule is writable shows its declarations: change one, press Enter, and it
is written straight into the stylesheet.

> Dictation uses the browser's speech API, which on Chrome sends audio to
> Google. It is opt-in per use and the button says so. Nothing else in Laminator
> touches the network.

Each saved comment becomes a pin on the element. When your agent resolves a
finding, that pin goes grey while you watch, because the queue is shared and the
browser polls it every three seconds.

## What it can and cannot anchor

This decides how useful a finding is:

| The tool says | What it means | What the agent gets |
| --- | --- | --- |
| `rule` | An authored stylesheet rule paints it | The exact `file:line`, the declarations, and how many elements that rule moves |
| `utility` | Tailwind or similar, so there is no rule | The class list and the component, so it edits the markup |
| `none` | A CSS module, a `<style>` block, or CSS-in-JS | The class list to search for |

CSS modules are excluded from the index on purpose. Their class names are hashed
at build time, so a selector seen in the browser cannot be traced back to source.
An anchor there would look right and point nowhere.

## Sending to an agent

**Setup → Open in** offers four choices:

- **New chat.** A fresh session, so the review does not interleave with whatever
  you were mid-way through.
- **Continue last.** A new window carrying your most recent conversation.
- **A named session.** A new window carrying that specific conversation.
- **Copy only.** Writes the file, opens nothing, puts the prompt on your clipboard.

> Nothing can type into a terminal that is already running. No agent CLI has a
> way in, and Claude Code's `--resume` on a live session starts a *copy*. So
> "send it to the terminal I already have open" is Copy only plus a paste, and
> the tool says so.

## How the agent works the queue

`laminator init` writes `.laminator/review-ui.md`, a command file generated for
your project, naming your frameworks, your source roots, and your own test and
lint commands. If you have a `.claude/` directory it also installs it as the
slash command `/laminator-review`.

It tells the agent to:

1. Read the live queue (`curl http://127.0.0.1:7317/queue`) rather than the snapshot
2. Read `laminator.styling` first, because `rule`, `utility` and `none` each need
   different work
3. Fix one finding at a time, and after each one post what it did into the thread
   and mark it resolved, so the pins drain in front of you
4. Use `dismissed`, with a reason, for anything it decides not to change
5. Finish by running your project's own typecheck, lint and tests

Edit that file. It is yours, `laminator scan` is the only thing that regenerates
it, and anything you add is what your agent will actually follow.

## Setting it up for *your* project

The scan writes `.laminator/config.json` in plain JSON, meant to be read and
argued with:

```jsonc
{
  "project":  { "name": "...", "frameworks": ["vite"], "styling": ["stylesheets"] },
  "styles": {
    "editable": ["styles/site.css", "styles/cards.css"],
    "excluded": [{ "file": "x.module.css", "why": "CSS module, class names are hashed…" }]
  },
  "overrides": {
    "surfaceRoot":   "",          // CSS selector for your app's main container
    "includeStyles": [],          // stylesheets the scan missed
    "excludeStyles": []           // stylesheets it must never write to
  }
}
```

`overrides` survives a re-scan; everything else is regenerated. Run
`laminator scan` after you add, move or rename stylesheets, and `laminator
doctor` whenever you want to see what it currently believes.

**`surfaceRoot`** is worth setting if your paths look long. A reported path
climbs until it reaches `<main>` or `<body>`, so an app that wraps everything in
a few generic divs produces `div.wrapper > div.inner > section.grid > h2.title`
when `h2.title` was the point. Give it the selector your app's container
actually uses and paths stop there instead.

**If it found no stylesheets**, a pure-Tailwind or pure-CSS-in-JS project
genuinely has no rule to point at. Laminator still captures the element, its
classes, its component and its computed styles. It reports `utility` or `none`
instead of inventing a `file:line`.

## Privacy and safety

- Binds to `127.0.0.1` only, never `0.0.0.0`, so nothing on your network can
  reach it.
- Zero dependencies. Nothing is fetched at install beyond this package.
- Any web page you visit can send a request to localhost. The browser blocks it
  from *reading* the reply but not from making it. Since this server can write to
  your stylesheets, every mutating request from a page must carry a token
  generated at `init`, and the script that carries it is only served to localhost
  origins. Requests with no `Origin`, such as your agent's `curl`, are treated as
  local processes.
- The write endpoint takes a file, a line, a property and a value. There is no
  free-text write, the file must be one the scan listed as editable, and it must
  resolve inside your project.
- `.laminator/` carries its own `.gitignore` of `*`, so a review never shows up in
  `git status`.

## Commands

```
laminator init      scan, write the command file, print the snippet
laminator           serve (scans first if it has never run)
laminator scan      re-read the project
laminator doctor    what it found, and what it could not

  --root DIR       project to work on          (default: cwd)
  --port N         port for the sidecar        (default: 7317)
```

## Troubleshooting

The short version is below. [SETUP.md](SETUP.md) is the long one, covering agent
CLIs, dictation, ports and what to do when the scan finds nothing.

**The toolbar does not appear.** Check the browser console for the `laminator`
banner. No banner means the script tag did not load. Is `laminator` running, and
is the port in the tag the same one it printed?

**Everything says "no authored rule".** Run `laminator doctor`. If it reports
`stylesheets 0 editable`, the scan found none. Add them to
`overrides.includeStyles` and re-scan.

**A finding points at the wrong line.** The stylesheet changed since the scan.
Run `laminator scan`.

**401 on every action.** The token changed, which only happens if
`.laminator/config.json` was deleted. Reload the page to fetch a fresh script.

## Docs

Live at **https://alphapatil-26.github.io/Laminator/**

The site in [`docs/`](docs/) is one static HTML file with no build step.

```bash
npm run site          # http://localhost:3000
```

It deploys unchanged to Railway (`railway.json` and a `Procfile` are included),
or to Vercel, Netlify, or any static host.

## Telling your agent about it

Copy [`AGENTS.md`](AGENTS.md) into your project, either as `AGENTS.md` or pasted
into `CLAUDE.md` or `.cursorrules`. It explains what Laminator is, how to read the
queue, and how to close findings so the pins grey out while the owner watches.

`laminator init` also writes `.laminator/review-ui.md`, generated for *your*
project with *your* test and lint commands, and installs it as the
`/laminator-review` slash command if you have a `.claude/` directory.

## Licence

MIT.
