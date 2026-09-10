# Setting Laminator up, and what to do when it misbehaves

Three commands and one line of HTML. If that already worked, you do not need
this file. It exists for the parts that fail on a real machine.

```bash
npm i -D laminator     # or: npx laminator init
npx laminator init     # scans, prints the script tag
npx laminator          # serves on 127.0.0.1:7317
```

Then paste the printed line into your app, in development only, and press
**Ctrl/Cmd + Shift + F** in the browser. A round button sits bottom-right; click
it if you would rather not use the shortcut.

Run **`npx laminator doctor`** at any point. It prints what the scan found, which
agent CLIs are installed, and the exact script tag for your port.

---

## Install problems

### `npm i -D laminator` returns 404

Almost always a cached negative lookup: npm remembers that a name did not exist
and keeps saying so for a few minutes. Clear it.

```bash
npm cache clean --force
npm i -D laminator
```

If it still 404s, check you are on the public registry. A work machine pointed at
a private mirror will not have this package:

```bash
npm config get registry     # want https://registry.npmjs.org/
```

You can always skip npm entirely:

```bash
npm i -D github:Alphapatil-26/Laminator
```

### `laminator: command not found`

`npx laminator` looks in `node_modules/.bin` of the current directory. Run it from
your project root, the folder with `package.json`. If you installed it globally
instead, `npm ls -g laminator` should list it.

### Node is too old

Needs Node 18 or newer. `node --version` to check.

---

## The toolbar never appears

Open the browser console and look for a blue `laminator` banner.

**No banner** means the script never loaded. In order:

1. Is `npx laminator` running in a terminal? It stays in the foreground.
2. Does the port in your script tag match the one it printed? If 7317 was taken
   it will have chosen another, or you passed `--port`.
3. Is the tag inside the part of the page that actually renders? In a framework,
   a tag in a component that never mounts will not load.
4. Open `http://127.0.0.1:7317/client.js` directly. You should see JavaScript
   starting with `window.__LAMINATOR__=`.

**A banner but no toolbar**: press Ctrl/Cmd + Shift + F. If the page has its own
handler for that combination, the launcher button bottom-right does the same job.

**`served without config`** in the console means the file was loaded from
somewhere other than the laminator server, so it has no port or token. Load it
from `http://127.0.0.1:<port>/client.js` rather than copying the file into your
own assets.

---

## Agent CLI problems

Laminator can hand a review to `claude`, `codex`, or `gemini`. **None of them is
required.** Without one, Send still writes the review file and copies the prompt
to your clipboard, and you paste it wherever you like.

`npx laminator doctor` prints which ones it can see.

### It says my CLI is not installed, but I can run it

The check spawns the command the same way the handoff will. It failing here means
the handoff would fail too, so it is worth resolving rather than working around.

**On Windows** this is the usual cause: npm installs `claude` as a `claude.ps1`
and `claude.cmd` shim and **no `claude.exe`**. Node's `spawn('claude')` fails with
`ENOENT` and `spawn('claude.cmd')` fails with `EINVAL`. Laminator goes through
`cmd /c` for exactly this reason. If your CLI is on the PATH only inside PowerShell's
profile, it will not be visible; put it on the system PATH.

**On macOS and Linux**, a CLI installed by a version manager (nvm, asdf, mise) is
often on the PATH only in an interactive shell. Check with `command -v claude`
from a plain non-login shell.

### Send opens a window that flashes and closes

The command started and exited. Run it by hand in a terminal to see the error;
usually an expired login or a model name the CLI does not recognise.

### The model dropdown only offers "Default"

Only Claude Code publishes a model list and an effort flag. `codex` and `gemini`
are offered `default` alone rather than a guessed list, because an invented model
id looks authoritative in a dropdown and then fails at the terminal.

Leaving both on **Default** is usually right: it passes no flag at all, so the
session inherits whatever your agent's own settings file pins. Choosing `opus`
explicitly would override a pinned `opus[1m]` and silently drop the 1M-context
build.

### "Send it to the terminal I already have open"

Not possible, by anyone. No agent CLI can accept text into a running session, and
Claude Code's `--resume` on a live session starts a *copy*. **Copy only** plus a
paste is the honest version, and that is what the option does.

---

## Dictation (the microphone)

The mic button appears **only if the browser has the Web Speech API**. If you
cannot see it at all, the browser is the reason.

| Browser | Dictation |
| --- | --- |
| Chrome, Edge | yes |
| Safari | partial; needs Dictation enabled in System Settings |
| Firefox | not implemented, so no button |

It also needs a **secure context**. `https://` and `http://localhost` count.
`http://192.168.1.x:3000` does **not** — so if you are reaching your dev server
from another machine by IP, the API is unavailable and the button will not render.
Use an SSH tunnel or a `localhost` address on the machine itself.

Paste this in the console to see which condition is failing:

```js
console.table({
  secureContext: window.isSecureContext,
  origin: location.origin,
  api: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  mediaDevices: !!navigator.mediaDevices,
})
```

`api: false` with `secureContext: false` is the IP-address case above. `api: false`
with `secureContext: true` is Firefox. Both true, but nothing happens when you
click: the microphone permission was denied for this origin — check the padlock
in the address bar.

Note where the audio goes: Chrome's Web Speech API is not on-device. It streams to
Google's speech service and returns text. That is why it is opt-in per use and the
button says so. Nothing else in Laminator touches the network.

---

## Anchoring problems

### Everything says "no authored rule"

Run `npx laminator doctor`. If it reports `stylesheets 0 editable`, the scan found
none. Add them by hand and re-scan:

```jsonc
// .laminator/config.json
"overrides": { "includeStyles": ["src/styles/app.css"] }
```

```bash
npx laminator scan
```

A pure-Tailwind or pure-CSS-in-JS project genuinely has no rule to point at. You
will get `utility` or `none` instead of an invented `file:line`, plus the class
list, the component and the computed styles.

### A finding points at the wrong line

The stylesheet changed since the scan. `npx laminator scan`.

### CSS modules never resolve

Deliberate. Their class names are hashed at build time, so a selector seen in the
browser cannot be traced back to source. An anchor there would look right and
point nowhere, so they are excluded and the reason is recorded in
`.laminator/config.json`.

### The reported path is very long

Paths climb until they reach `<main>` or `<body>`. If your app wraps everything in
generic divs you get `div.wrapper > div.inner > section.grid > h2.title`. Name your
real container:

```jsonc
"overrides": { "surfaceRoot": "#app-content" }
```

Survives a re-scan. No restart needed beyond reloading the page.

---

## Server problems

### `EADDRINUSE`

Something already holds the port, often a laminator you forgot to stop.

```bash
npx laminator --port 7400
```

Remember to update the port in your script tag, or re-run `init` to reprint it.

### 401 on every action

The token changed, which only happens if `.laminator/config.json` was deleted or
regenerated. Reload the page to fetch a fresh script.

### 403 `only serves localhost origins`

The page asking is not on localhost. This is the point: any site you visit can
send requests to your localhost, and this server can write to your stylesheets.

---

## Getting it out again

```bash
npm uninstall laminator
rm -rf .laminator .claude/commands/laminator-review.md
```

Then delete the script tag. Nothing else is left behind: no global config, no
daemon, no account. `.laminator/` was ignored by its own `.gitignore`, so it never
touched your history.
