/* Laminator overlay — runs inside the page being reviewed.
 *
 * SHADOW DOM, not a plain div. This runs inside somebody else's stylesheet, and
 * the host is entitled to say `* { box-sizing: content-box }` or `button {
 * all: unset }`. A tool that renders into the light DOM inherits every one of
 * those and looks broken on exactly the projects that most need it.
 *
 * NO FRAMEWORK. Not purity: the overlay must mount on React, Vue, Svelte, Rails
 * and a static HTML file from the same one line, and the moment it needs a
 * framework it needs a build per framework.
 *
 * WHAT IT NEVER DOES: no network call to anywhere but 127.0.0.1, no analytics,
 * no storage beyond this origin's localStorage for your own preferences. The one
 * exception is dictation, which is Chrome's Web Speech API and therefore sends
 * audio to Google — it is opt-in per use and the button says so.
 */
(() => {
    'use strict'
    const CFG = window.__LAMINATOR__
    if (!CFG) return console.warn('[laminator] served without config — load /client.js from the laminator server')
    if (window.__LAMINATOR_MOUNTED__) return
    window.__LAMINATOR_MOUNTED__ = true

    const BASE = `http://127.0.0.1:${CFG.port}`
    const KEY = 'laminator:settings'
    const api = async (path, body) => {
        const res = await fetch(BASE + path, {
            method: body ? 'POST' : 'GET',
            headers: body ? { 'content-type': 'application/json', 'x-laminator-token': CFG.token } : {},
            body: body ? JSON.stringify(body) : undefined,
        })
        return res.json()
    }

    const settings = Object.assign(
        { agent: 'claude', target: 'new', model: 'default', brief: '' },
        (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {} } catch { return {} } })(),
    )
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch {} }

    /* ─────────────────────────── describing the DOM ─────────────────────── */

    const OURS = (n) => n && n.closest && n.closest('#laminator-root')

    function elementPath(el) {
        const parts = []
        let n = el
        for (let i = 0; n && n.nodeType === 1 && i < 6; i++) {
            let s = n.tagName.toLowerCase()
            if (n.id) { parts.unshift(`${s}#${n.id}`); break }
            const cls = [...n.classList].filter((c) => !/^(ng|v)-/.test(c)).slice(0, 2)
            if (cls.length) s += '.' + cls.join('.')
            parts.unshift(s)
            n = n.parentElement
            if (n && (n.tagName === 'MAIN' || n.tagName === 'BODY')) break
        }
        return parts.join(' > ')
    }

    function tokensOf(el) {
        const out = []
        if (el.id) out.push('#' + el.id)
        for (const c of el.classList) out.push('.' + c)
        for (const a of el.attributes) if (a.name.startsWith('data-') || a.name.startsWith('aria-')) out.push('[' + a.name + ']')
        return out
    }

    const specificity = (sel) =>
        (sel.match(/#/g) || []).length * 100 + (sel.match(/\.|\[/g) || []).length * 10 + (sel.match(/^[a-z]|\s[a-z]/g) || []).length

    /**
     * Which authored rule actually paints this element.
     *
     * The server proposes candidates from its index; only the BROWSER can say
     * which of them match, so it confirms each with `matches()` and keeps the
     * most specific. A prelude with a comma is split first — `.a, .b` is two
     * selectors and only one of them may be why this element is styled.
     */
    async function resolveRule(el) {
        const tokens = tokensOf(el)
        if (!tokens.length) return null
        let candidates = []
        try { ({ candidates = [] } = await api('/rules', { tokens })) } catch { return null }
        let best = null
        for (const c of candidates) {
            for (const one of c.prelude.split(',')) {
                const sel = one.trim().replace(/::?[a-z-]+(\([^)]*\))?/g, '')
                if (!sel) continue
                let hit = false
                try { hit = el.matches(sel) } catch { continue }
                if (!hit) continue
                const score = specificity(sel)
                if (!best || score >= best.score) best = { ...c, score, matched: sel }
            }
        }
        if (!best) return null
        let siblings = 0
        try { siblings = document.querySelectorAll(best.matched).length } catch {}
        return { file: best.file, line: best.line, prelude: best.prelude, at: best.at, declarations: best.declarations, siblings, writable: best.writable }
    }

    const STYLE_PROPS = ['display', 'position', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'padding', 'margin', 'border-radius', 'width', 'height', 'gap']

    /** Component names from a React fiber, when there is one. Names only —
     *  React 19 removed the source locations these used to carry. */
    function reactChain(el) {
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
        if (!key) return null
        const NOISE = /Provider|Consumer|Context|Boundary|Router|Portal|^_c|^Fragment$|^Suspense/
        const names = []
        let f = el[key]
        for (let i = 0; f && i < 60; i++) {
            const t = f.type
            const n = typeof t === 'function' ? t.displayName || t.name : typeof t === 'object' && t ? t.displayName : null
            if (n && !NOISE.test(n) && names[names.length - 1] !== n) names.push(n)
            f = f.return
        }
        return names.slice(0, 5).reverse().join(' > ') || null
    }

    /** Neighbours whose edges NEARLY line up. "Nearly" is the point: a 2px miss
     *  is a bug worth reporting and a 0px match is not worth a word. */
    function misalignments(el) {
        const out = []
        const r = el.getBoundingClientRect()
        const sibs = [...(el.parentElement?.children ?? [])].filter((s) => s !== el).slice(0, 8)
        for (const s of sibs) {
            if (OURS(s)) continue
            const b = s.getBoundingClientRect()
            for (const [edge, a, c] of [['top', r.top, b.top], ['left', r.left, b.left], ['bottom', r.bottom, b.bottom], ['right', r.right, b.right]]) {
                const off = Math.abs(a - c)
                if (off > 0.4 && off <= 6) out.push({ sibling: elementPath(s).split(' > ').pop(), edge, off: Math.round(off * 10) / 10 })
            }
        }
        return out.slice(0, 4)
    }

    async function capture(el, extra = {}) {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        const rule = await resolveRule(el)
        const utility = !rule && el.classList.length > 0 && (CFG.project.styling || []).includes('tailwind')
        const mis = misalignments(el)
        return Object.assign({
            comment: '',
            elementPath: elementPath(el),
            element: el.tagName.toLowerCase(),
            url: location.pathname,
            x: Math.round((r.left + r.width / 2) / innerWidth * 1000) / 10,
            y: Math.round(r.top + scrollY),
            boundingBox: { x: Math.round(r.left), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
            cssClasses: [...el.classList].join(' ') || null,
            computedStyles: STYLE_PROPS.map((p) => `${p}: ${cs.getPropertyValue(p)}`).join('; '),
            nearbyText: (el.textContent || '').trim().slice(0, 120) || null,
            reactComponents: reactChain(el),
            laminator: {
                rule,
                styling: rule ? 'rule' : utility ? 'utility' : 'none',
                viewport: { w: innerWidth, h: innerHeight },
                theme: document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
                misaligned: mis.length ? mis : undefined,
                paused: paused || undefined,
            },
        }, extra)
    }

    /* ───────────────────────────── screenshots ──────────────────────────── */
    /* Real pixels of the real tab. A headless re-render would photograph a
     * login page for any signed-in route and miss the open menu, the hover
     * state and the paused frame that made the moment worth annotating. */

    let stream = null, video = null

    async function enableShots() {
        if (stream && stream.active) return { ok: true }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return { ok: false, why: 'this browser has no screen capture' }
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { displaySurface: 'browser' }, audio: false,
                preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'exclude',
            })
        } catch (e) {
            return { ok: false, why: e && e.name === 'NotAllowedError' ? 'permission denied' : 'capture unavailable' }
        }
        const track = stream.getVideoTracks()[0]
        if (track) track.addEventListener('ended', () => { stopShots(); shots = false; say('Screen sharing stopped'); render() })
        const v = document.createElement('video')
        v.srcObject = stream; v.muted = true; v.playsInline = true
        // Off-screen but LAID OUT: `display:none` stops a video painting, and a
        // video that never paints has no frame for drawImage to copy.
        v.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
        document.body.appendChild(v)
        try { await v.play() } catch {}
        video = v
        const s = (track && track.getSettings && track.getSettings()) || {}
        if (s.displaySurface && s.displaySurface !== 'browser') {
            return { ok: false, why: 'that is not this tab — pick the tab, not a window or screen' }
        }
        return { ok: true }
    }

    function stopShots() {
        if (stream) stream.getTracks().forEach((t) => t.stop())
        stream = null
        if (video) video.remove()
        video = null
    }

    const nextFrame = (v) => new Promise((res) => {
        if (typeof v.requestVideoFrameCallback === 'function') { v.requestVideoFrameCallback(() => res()); setTimeout(res, 250) }
        else setTimeout(res, 120)
    })

    /** A PNG of `rect` with room around it — an element cropped to its own edges
     *  shows nothing about the spacing the complaint is usually about. */
    async function grabShot(rect) {
        const v = video
        if (!v || !stream || !stream.active || !v.videoWidth) return null
        const pad = 48
        host.style.visibility = 'hidden'
        try {
            await nextFrame(v)
            // Derived from the frame, not from devicePixelRatio: browser zoom and
            // Chrome's own capture downscaling both move it.
            const scale = v.videoWidth / innerWidth
            const l = Math.max(0, rect.x - pad), t = Math.max(0, rect.y - pad)
            const rgt = Math.min(innerWidth, rect.x + rect.width + pad)
            const bot = Math.min(innerHeight, rect.y + rect.height + pad)
            const w = Math.round((rgt - l) * scale), h = Math.round((bot - t) * scale)
            if (w < 2 || h < 2) return null
            const c = document.createElement('canvas')
            c.width = w; c.height = h
            c.getContext('2d').drawImage(v, Math.round(l * scale), Math.round(t * scale), w, h, 0, 0, w, h)
            return c.toDataURL('image/png')
        } catch { return null } finally { host.style.visibility = '' }
    }

    /* ───────────────────────────── dictation ────────────────────────────── */

    let recog = null
    const speechOK = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition)

    function toggleVoice() {
        if (recog) { recog.__stopped = true; try { recog.stop() } catch {} ; recog = null; listening = false; heard = ''; render(); return }
        const C = window.SpeechRecognition || window.webkitSpeechRecognition
        if (!C) return say('This browser has no speech recognition')
        const r = new C()
        r.lang = navigator.language || 'en-US'; r.continuous = true; r.interimResults = true
        r.onresult = (e) => {
            let fin = '', mid = ''
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = (e.results[i][0] && e.results[i][0].transcript) || ''
                if (e.results[i].isFinal) fin += t; else mid += t
            }
            // Only FINAL text is appended. The engine revises interim results,
            // and a caller that already committed cannot take the revision back.
            if (fin.trim() && draft) draft.text = (draft.text ? draft.text.replace(/\s+$/, '') + ' ' : '') + fin.trim()
            heard = mid
            render()
        }
        r.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return
            recog = null; listening = false; heard = ''
            say(`Dictation stopped — ${e.error === 'not-allowed' ? 'microphone blocked' : e.error}`, 5000)
            render()
        }
        // Chrome ends the session after a silence even with `continuous`, so a
        // long thoughtful sentence would otherwise be cut in half.
        r.onend = () => { if (r.__stopped) return; try { r.start() } catch { recog = null; listening = false; render() } }
        try { r.start() } catch { return say('Could not start dictation') }
        recog = r; listening = true; render()
    }

    /* ────────────────────────────── the shell ───────────────────────────── */

    const host = document.createElement('div')
    host.id = 'laminator-root'
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
    document.documentElement.appendChild(host)
    const sr = host.attachShadow({ mode: 'open' })
    sr.innerHTML = `<style>
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
.bar { position:fixed; right:16px; bottom:16px; display:flex; align-items:center; gap:2px; height:48px;
  padding:0 8px; border-radius:24px; border:1px solid #33333b; background:#1c1c1e;
  box-shadow:0 10px 34px rgb(0 0 0/46%); pointer-events:auto; max-width:calc(100vw - 32px); }
button { border:0; background:transparent; color:#8e8e96; font:inherit; font-size:12px; cursor:pointer;
  border-radius:10px; height:34px; padding:0 9px; white-space:nowrap; }
button:hover:not(:disabled) { background:#2a2a30; color:#f2f2f7; }
button:disabled { opacity:.32; cursor:default; }
button[data-on="1"] { background:#2f6df6; color:#fff; }
.send { background:#2f6df6; color:#fff; font-weight:600; padding:0 14px; }
.send:hover:not(:disabled) { background:#4680ff; }
.send:disabled { background:#2a2a30; color:#6c6c76; }
.div { width:1px; height:20px; margin:0 4px; background:#35353d; flex:none; }
.hi { position:fixed; pointer-events:none; border-radius:3px; outline:2px solid #2f6df6; outline-offset:1px;
  background:rgb(47 109 246/10%); }
.hi[data-kind="picked"] { outline-style:dashed; background:rgb(47 109 246/18%); }
.rubber { position:fixed; pointer-events:none; border:1px dashed #2f6df6; border-radius:3px;
  background:rgb(47 109 246/12%); }
.pop { position:fixed; width:352px; border-radius:14px; border:1px solid #33333b; background:#1c1c1e;
  color:#e6e6ea; box-shadow:0 18px 48px rgb(0 0 0/58%); pointer-events:auto; overflow:hidden; font-size:12.5px;
  max-height:86vh; display:flex; flex-direction:column; }
.pophead { display:flex; align-items:center; gap:8px; padding:9px 12px; background:#26262c;
  border-bottom:1px solid #2b2b33; font-weight:700; color:#f2f2f7; cursor:grab; user-select:none; }
.pophead span { flex:1; }
.popbody { padding:11px 12px; overflow:auto; }
.where { color:#8e8e96; font-size:11px; line-height:1.5; margin-bottom:8px; word-break:break-word; }
.where b { background:rgb(47 109 246/16%); color:#9db8ff; border-radius:4px; padding:1px 5px; margin-left:4px; }
.where b.warn { background:rgb(249 115 22/16%); color:#f9a06b; }
.where i { color:#f9a06b; font-style:normal; margin-left:6px; }
q { display:block; margin:0 0 9px; padding:7px 9px; border-left:2px solid #3a3a42; border-radius:0 6px 6px 0;
  background:#17171b; color:#c8c8d0; font-size:11.5px; line-height:1.5; quotes:none; max-height:96px; overflow:auto; }
.wrap { position:relative; }
textarea { display:block; width:100%; min-height:66px; padding:9px 10px; border:1px solid #35353d;
  border-radius:9px; background:#141418; color:#f2f2f7; font:inherit; font-size:12.5px; resize:vertical; }
textarea:focus-visible { outline:2px solid #2f6df6; border-color:transparent; }
.mic { position:absolute; right:7px; bottom:9px; width:26px; height:26px; padding:0; border-radius:7px;
  background:#26262c; color:#8e8e96; display:grid; place-items:center; font-size:10px; }
.mic[data-on="1"] { background:#ef4444; color:#fff; }
.heard { display:flex; align-items:center; gap:7px; margin:7px 0 0; color:#8e8e96; font-size:11px; min-height:15px; }
.dot { width:7px; height:7px; border-radius:50%; background:#ef4444; animation:pulse 1.1s ease-in-out infinite; flex:none; }
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.35;transform:scale(.72)} }
.chips { display:flex; gap:6px; }
.chips button { flex:1; background:#2f2f35; color:#c8c8d0; border-radius:7px; height:30px; padding:0 8px; }
.chips button[data-on="1"] { background:#2f6df6; color:#fff; font-weight:600; }
.lbl { display:block; margin:10px 0 5px; color:#6c6c76; font-size:10px; text-transform:uppercase; letter-spacing:.07em; }
.popfoot { display:flex; gap:8px; align-items:center; padding:9px 12px; border-top:1px solid #2b2b33; background:#19191c; }
.popfoot .sp { flex:1; color:#6c6c76; font-size:10.5px; }
.decl { display:flex; align-items:center; gap:6px; margin-bottom:5px; }
.decl code { flex:1; color:#9db8ff; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px;
  overflow:hidden; text-overflow:ellipsis; }
.decl input { width:116px; padding:4px 7px; border:1px solid #35353d; border-radius:6px; background:#141418;
  color:#f2f2f7; font:inherit; font-size:11px; font-family:ui-monospace,Menlo,Consolas,monospace; }
.decl input:focus-visible { outline:2px solid #2f6df6; border-color:transparent; }
.marker { position:fixed; width:20px; height:20px; transform:translate(-50%,-50%); border:2px solid #fff;
  border-radius:50%; background:#2f6df6; color:#fff; font-size:10.5px; font-weight:700; display:grid;
  place-items:center; cursor:pointer; pointer-events:auto; box-shadow:0 2px 8px rgb(0 0 0/40%); padding:0; }
.marker[data-status="resolved"], .marker[data-status="dismissed"] { background:#52525b; opacity:.6; }
.marker[data-multi="1"] { border-radius:6px; }
.panel { position:fixed; right:16px; bottom:72px; width:328px; max-height:62vh; overflow:auto; padding:12px;
  border-radius:16px; border:1px solid #33333b; background:#1c1c1e; color:#e6e6ea; pointer-events:auto;
  box-shadow:0 16px 44px rgb(0 0 0/55%); font-size:12px; }
.row { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:36px;
  border-bottom:1px solid #26262d; }
.row:last-child { border-bottom:0; }
.row b { color:#f2f2f7; }
select { appearance:none; background:#2a2a30; color:#f2f2f7; border:0; border-radius:8px; padding:6px 26px 6px 10px;
  font:inherit; font-size:12px; cursor:pointer; text-align:right;
  background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%238e8e96' stroke-width='1.6' stroke-linecap='round'%3E%3Cpath d='M4 6.5L8 10.5L12 6.5'/%3E%3C/svg%3E");
  background-repeat:no-repeat; background-position:right 7px center; background-size:13px; }
select option { background:#1c1c1e; color:#f2f2f7; }
.item { display:flex; gap:8px; align-items:flex-start; padding:7px 0; border-bottom:1px solid #26262d; }
.item i { display:block; color:#6c6c76; font-style:normal; font-size:10.5px; margin-top:2px; }
.n { flex:none; width:18px; height:18px; border-radius:9px; background:#2f6df6; color:#fff; font-size:10px;
  display:grid; place-items:center; }
.item[data-status="resolved"] .n, .item[data-status="dismissed"] .n { background:#52525b; }
.toast { position:fixed; right:16px; bottom:72px; max-width:min(420px,calc(100vw - 32px)); width:max-content;
  padding:8px 12px; border-radius:10px; border:1px solid #33333b; background:#1c1c1e; color:#c8c8d0;
  pointer-events:none; font-size:12px; box-shadow:0 8px 22px rgb(0 0 0/40%); }
.note { color:#8e8e96; font-size:11px; line-height:1.45; padding:8px 0 0; margin:0; }
.note code { color:#9db8ff; }
</style><div id="ui"></div>`
    const ui = sr.getElementById('ui')

    /* ────────────────────────────── state ──────────────────────────────── */

    let open = false, mode = null, draft = null, list = [], panel = null
    let toast = null, toastAt = 0, hover = null, intent = null, severity = null
    let sessions = [], picked = [], rubber = null, dragFrom = null
    let shots = false, listening = false, heard = '', paused = false, savings = null
    let popPos = null, dragPop = null
    const nodes = new Map()

    const say = (t, ms = 3200) => {
        toast = t; toastAt = Date.now(); render()
        setTimeout(() => { if (Date.now() - toastAt >= ms - 50) { toast = null; render() } }, ms)
    }
    const openCount = () => list.filter((a) => a.status !== 'resolved' && a.status !== 'dismissed').length

    async function pull() {
        try { const j = await api('/queue'); list = j.annotations || []; render() } catch {}
    }

    /* ────────────────────────── drafting ───────────────────────────────── */

    async function beginDraft(el, opts) {
        opts = opts || {}
        const box = opts.area || el.getBoundingClientRect()
        const rect = opts.area || { x: box.left, y: box.top, width: box.width, height: box.height }
        const shot = shots ? await grabShot(rect) : null
        const rec = await capture(el, {
            selectedText: opts.selectedText,
            isMultiSelect: opts.members && opts.members.length ? true : undefined,
        })
        if (opts.members && opts.members.length) {
            rec.laminator.members = opts.members.map((m) => elementPath(m).split(' > ').pop())
        }
        if (opts.area) rec.laminator.area = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        rec.laminator.mode = opts.mode || 'element'
        draft = {
            rec, text: '', shot,
            edits: Object.assign({}, (rec.laminator.rule && rec.laminator.rule.declarations) || {}),
            at: popPos || {
                x: Math.min(Math.max(12, rect.x), innerWidth - 364),
                y: Math.min(rect.y + rect.height + 8, innerHeight - 380),
            },
        }
        mode = null; hover = null; picked = []; rubber = null
        render()
    }

    /** Leaving multi mode is the "done" gesture. The version this came from hid
     *  it in a rail button, and the mode read as one that collects things and
     *  then does nothing with them. */
    function finishMulti() {
        if (!picked.length) { mode = null; render(); return }
        const first = picked[0], rest = picked.slice(1)
        beginDraft(first, { members: rest, mode: 'multi' })
    }

    /** The deepest element that fully contains a dragged region. */
    function containerFor(box) {
        const cands = [].slice.call(document.querySelectorAll('body *')).filter((e) => {
            if (OURS(e)) return false
            const r = e.getBoundingClientRect()
            return r.left <= box.x + 2 && r.top <= box.y + 2 && r.right >= box.x + box.width - 2 && r.bottom >= box.y + box.height - 2
        })
        return cands[cands.length - 1] || document.body
    }

    const inside = (box) => [].slice.call(document.querySelectorAll('body *')).filter((e) => {
        if (OURS(e)) return false
        const r = e.getBoundingClientRect()
        return r.width > 4 && r.height > 4 && r.left >= box.x - 2 && r.top >= box.y - 2 &&
            r.right <= box.x + box.width + 2 && r.bottom <= box.y + box.height + 2
    }).slice(0, 12)

    /* ────────────────────────────── render ─────────────────────────────── */

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const MODES = [['element', 'Pick'], ['text', 'Text'], ['multi', 'Multi'], ['area', 'Area']]
    const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB')

    function render() {
        if (!open) { ui.innerHTML = ''; return }
        const rule = draft && draft.rec.laminator.rule
        ui.innerHTML =
            (hover && mode && !draft ? `<div class="hi" style="left:${hover.left}px;top:${hover.top}px;width:${hover.width}px;height:${hover.height}px"></div>` : '') +
            picked.map((el) => { const b = el.getBoundingClientRect(); return `<div class="hi" data-kind="picked" style="left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px"></div>` }).join('') +
            (rubber ? `<div class="rubber" style="left:${rubber.x}px;top:${rubber.y}px;width:${rubber.width}px;height:${rubber.height}px"></div>` : '') +
            list.map((a, i) => {
                if (a.url && a.url !== location.pathname) return ''
                const el = nodeFor(a); if (!el) return ''
                const b = el.getBoundingClientRect()
                return `<button class="marker" data-status="${a.status}" data-multi="${a.isMultiSelect ? 1 : 0}" data-id="${a.id}" style="left:${b.left + b.width / 2}px;top:${b.top}px" title="${esc(a.comment)}">${i + 1}</button>`
            }).join('') +
            (toast ? `<div class="toast">${esc(toast)}</div>` : '') +
            (panel === 'setup' ? setupPanel() : '') +
            (panel === 'queue' && !draft ? queuePanel() : '') +
            (panel === 'stats' ? statsPanel() : '') +
            (draft ? popup(rule) : '') +
            `<div class="bar">
  ${MODES.map(([id, label]) => `<button data-mode="${id}" data-on="${mode === id ? 1 : 0}" title="${label} (${id[0].toUpperCase()})">${label}${id === 'multi' && picked.length ? ' ' + picked.length : ''}</button>`).join('')}
  <span class="div"></span>
  <button id="pause" data-on="${paused ? 1 : 0}" title="Freeze animations (P)">Freeze</button>
  <button id="shots" data-on="${shots ? 1 : 0}" title="Attach a screenshot to each finding. Chrome asks once — pick THIS TAB.">Shots</button>
  <span class="div"></span>
  <button id="q" data-on="${panel === 'queue' ? 1 : 0}">Comments${openCount() ? ' ' + openCount() : ''}</button>
  <button id="stats" data-on="${panel === 'stats' ? 1 : 0}">Saved</button>
  <button id="setup" data-on="${panel === 'setup' ? 1 : 0}">Setup</button>
  <span class="div"></span>
  <button class="send" id="send" ${openCount() ? '' : 'disabled'}>Send${openCount() ? ' ' + openCount() : ''}</button>
  <button id="close" title="Close (Esc)">×</button>
</div>`
        wire()
        if (draft) {
            const t = sr.getElementById('c')
            if (t && sr.activeElement !== t) { t.value = draft.text || ''; t.focus() }
        }
    }

    function popup(rule) {
        const rec = draft.rec
        const members = (rec.laminator.members && rec.laminator.members.length) || 0
        const title = rec.laminator.mode === 'area' ? 'Annotate region'
            : rec.isMultiSelect ? `Annotate ${members + 1} elements`
                : rec.selectedText ? 'Annotate text' : 'Annotate element'
        return `<div class="pop" style="left:${draft.at.x}px;top:${draft.at.y}px">
  <div class="pophead" id="grab"><span>${title}</span><button id="x">×</button></div>
  <div class="popbody">
    <div class="where">${esc(rec.elementPath)}${rule ? `<b>${esc(rule.file)}:${rule.line}</b>` : `<b class="warn">${rec.laminator.styling === 'utility' ? 'utility classes' : 'no authored rule'}</b>`}${rule && rule.siblings > 1 ? `<i>moves ${rule.siblings}</i>` : ''}${draft.shot ? '<i style="color:#4ade80">+ screenshot</i>' : ''}</div>
    ${rec.selectedText ? `<q>${esc(rec.selectedText)}</q>` : ''}
    <div class="wrap">
      <textarea id="c" placeholder="What is wrong here?"></textarea>
      ${speechOK() ? `<button class="mic" id="mic" data-on="${listening ? 1 : 0}" title="Dictate. Chrome sends the audio to Google's speech service.">${listening ? '■' : '●'}</button>` : ''}
    </div>
    ${listening ? `<p class="heard"><span class="dot"></span>${esc(heard || 'Listening…')}</p>` : ''}
    <span class="lbl">Intent</span>
    <div class="chips">${['fix', 'change', 'question', 'approve'].map((v) => `<button data-intent="${v}" data-on="${intent === v ? 1 : 0}">${v}</button>`).join('')}</div>
    <span class="lbl">Severity</span>
    <div class="chips">${['blocking', 'important', 'suggestion'].map((v) => `<button data-sev="${v}" data-on="${severity === v ? 1 : 0}">${v}</button>`).join('')}</div>
    ${rule && rule.writable ? `<span class="lbl">Try a change — writes ${esc(rule.file)}</span>
      ${Object.keys(draft.edits).slice(0, 6).map((p) => `<div class="decl"><code>${esc(p)}</code><input data-prop="${esc(p)}" value="${esc(draft.edits[p])}"></div>`).join('')}
      <p class="note">Enter applies it to the file. Your dev server hot-reloads; the undo is <code>git diff</code>.</p>` : ''}
  </div>
  <div class="popfoot"><span class="sp">Ctrl+Enter to save</span><button id="cancel">Cancel</button><button class="send" id="add">${draft.editing ? 'Update' : 'Add'}</button></div>
</div>`
    }

    const setupPanel = () => `<div class="panel">
  <div class="row"><span>Agent</span><select id="agent">${Object.keys(CFG.agents || { claude: 1 }).map((a) => `<option value="${a}"${settings.agent === a ? ' selected' : ''}>${a}</option>`).join('')}</select></div>
  <div class="row"><span>Open in</span><select id="target">
    <option value="new"${settings.target === 'new' ? ' selected' : ''}>New chat</option>
    <option value="continue"${settings.target === 'continue' ? ' selected' : ''}>Continue last</option>
    ${sessions.map((s) => `<option value="session:${s.sessionId}"${settings.target === 'session:' + s.sessionId ? ' selected' : ''}>${esc(s.name || s.sessionId.slice(0, 8))}</option>`).join('')}
    <option value="copy"${settings.target === 'copy' ? ' selected' : ''}>Copy only</option>
  </select></div>
  ${settings.target === 'copy'
            ? '<p class="note">Nothing opens. The prompt goes to your clipboard for the terminal you already have.</p>'
            : settings.target !== 'new'
                ? '<p class="note">Opens a <b>new window</b> carrying that conversation. Nothing can type into a terminal that is already running.</p>'
                : ''}
  <span class="lbl">Brief for the review chat</span>
  <textarea id="brief" rows="3" placeholder="What a new chat cannot know: what you're mid-way through, what not to touch.">${esc(settings.brief)}</textarea>
</div>`

    const queuePanel = () => `<div class="panel">
  ${list.length
            ? list.map((a, i) => `<div class="item" data-status="${a.status}"><span class="n">${i + 1}</span><span style="flex:1;min-width:0">${esc(a.comment)}<i>${esc(a.elementPath.split(' > ').pop())}${a.laminator && a.laminator.rule ? ` · ${esc(a.laminator.rule.file)}:${a.laminator.rule.line}` : ''}${a.status === 'resolved' ? ' · resolved' : ''}</i></span><button data-edit="${a.id}" title="Edit">&#9998;</button><button data-del="${a.id}" title="Delete">×</button></div>`).join('')
            : '<p class="note">Nothing yet. Pick a mode and click something.</p>'}
</div>`

    const statsPanel = () => `<div class="panel">
  ${savings && savings.batches ? `
    <div class="row"><span>Reading avoided</span><b>${kb(savings.avoidedBytes)}</b></div>
    <div class="row"><span>Review files cost</span><b>${kb(savings.suppliedBytes)}</b></div>
    <div class="row"><span>Batches sent</span><b>${savings.batches}</b></div>
    <div class="row"><span>Findings anchored</span><b>${savings.anchored}/${savings.annotations}</b></div>
    <p class="note"><b>Reading avoided</b> is measured in BYTES, not tokens: when a finding carries
      <code>file:line</code>, an agent without it would have had to read that stylesheet. Each file counts
      once per batch. It ignores the markup hunt and any question you would have been asked back, so it is
      deliberately low. Findings with no anchor score <b>zero</b> — what they save is real but has no size,
      and inventing a rate is how a number like this stops being worth reading. No tokens-per-byte figure is
      published, because it could not be measured honestly.</p>`
            : '<p class="note">Nothing sent yet. Numbers appear after the first Send.</p>'}
</div>`

    function nodeFor(a) {
        const cached = nodes.get(a.id)
        if (cached && cached.isConnected) return cached
        try {
            const el = document.querySelector(a.elementPath.split(' > ').pop())
            if (el) { nodes.set(a.id, el); return el }
        } catch {}
        return null
    }

    /* ────────────────────────────── wiring ─────────────────────────────── */

    function wire() {
        const on = (sel, ev, fn) => sr.querySelectorAll(sel).forEach((n) => n.addEventListener(ev, fn))
        on('[data-mode]', 'click', (e) => {
            const m = e.currentTarget.dataset.mode
            // Clicking Multi while already in Multi is the same "done" gesture
            // as pressing M, not a plain toggle.
            if (m === 'multi' && mode === 'multi') return finishMulti()
            mode = mode === m ? null : m; hover = null; picked = []; render()
        })
        on('#close', 'click', () => { open = false; mode = null; render() })
        on('#pause', 'click', () => { paused = !paused; applyFreeze(); render() })
        on('#shots', 'click', async () => {
            if (shots) { stopShots(); shots = false; render(); return say('Screenshots off') }
            const r = await enableShots()
            if (!r.ok) { render(); return say(`Screenshots off — ${r.why}`, 5000) }
            shots = true; render(); say('Screenshots on — findings will carry a picture')
        })
        on('#q', 'click', () => { panel = panel === 'queue' ? null : 'queue'; render() })
        on('#stats', 'click', async () => {
            panel = panel === 'stats' ? null : 'stats'; render()
            if (panel === 'stats') { try { savings = await api('/queue', { action: 'savings' }) } catch {} ; render() }
        })
        on('#setup', 'click', async () => {
            panel = panel === 'setup' ? null : 'setup'; render()
            if (panel === 'setup') { try { sessions = (await api('/sessions')).sessions || [] } catch {} ; render() }
        })
        on('#agent', 'change', (e) => { settings.agent = e.target.value; save() })
        on('#target', 'change', (e) => { settings.target = e.target.value; save(); render() })
        on('#brief', 'input', (e) => { settings.brief = e.target.value; save() })
        on('[data-del]', 'click', async (e) => { await api('/queue', { action: 'delete', id: e.currentTarget.dataset.del }); pull() })
        on('[data-edit]', 'click', (e) => {
            const a = list.find((x) => x.id === e.currentTarget.dataset.edit); if (!a) return
            // Editing from the LIST as well as the pin: pins are hidden on every
            // route but their own, so without this a comment made elsewhere
            // could never be reworded.
            intent = a.intent || null; severity = a.severity || null; panel = null
            draft = {
                rec: a, text: a.comment, editing: a.id, shot: null,
                edits: Object.assign({}, (a.laminator && a.laminator.rule && a.laminator.rule.declarations) || {}),
                at: { x: Math.max(12, innerWidth / 2 - 176), y: 120 },
            }
            render()
        })
        on('.marker', 'click', (e) => { const a = list.find((x) => x.id === e.currentTarget.dataset.id); if (a) say(a.comment, 5000) })
        on('#x,#cancel', 'click', () => { draft = null; intent = severity = null; popPos = null; render() })
        on('[data-intent]', 'click', (e) => { intent = intent === e.currentTarget.dataset.intent ? null : e.currentTarget.dataset.intent; render() })
        on('[data-sev]', 'click', (e) => { severity = severity === e.currentTarget.dataset.sev ? null : e.currentTarget.dataset.sev; render() })
        on('#c', 'input', (e) => { if (draft) draft.text = e.target.value })
        on('#c', 'keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commit() } })
        on('#mic', 'click', toggleVoice)
        on('#add', 'click', commit)
        on('#send', 'click', send)
        on('[data-prop]', 'keydown', async (e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            const prop = e.currentTarget.dataset.prop, value = e.currentTarget.value
            const rule = draft && draft.rec.laminator.rule
            if (!rule) return
            const j = await api('/css', { file: rule.file, line: rule.line, property: prop, value })
            if (!j.ok) return say(j.why || 'could not write that', 5000)
            draft.edits[prop] = value
            say(`${prop}: ${value} → ${rule.file}:${rule.line}`, 4000)
        })
        on('#grab', 'pointerdown', (e) => {
            const p = sr.querySelector('.pop').getBoundingClientRect()
            dragPop = { dx: e.clientX - p.left, dy: e.clientY - p.top }
            e.currentTarget.setPointerCapture(e.pointerId)
        })
        on('#grab', 'pointermove', (e) => {
            if (!dragPop || !draft) return
            draft.at = { x: Math.max(8, e.clientX - dragPop.dx), y: Math.max(8, e.clientY - dragPop.dy) }
            popPos = draft.at
            const p = sr.querySelector('.pop')
            p.style.left = draft.at.x + 'px'; p.style.top = draft.at.y + 'px'
        })
        on('#grab', 'pointerup', () => { dragPop = null })
    }

    /** Two mechanisms, because neither catches the other: `animation-play-state`
     *  freezes CSS keyframes, `getAnimations()` covers Web Animations and
     *  transitions already in flight. */
    let freezeEl = null
    function applyFreeze() {
        if (paused) {
            freezeEl = document.createElement('style')
            freezeEl.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important}'
            document.head.appendChild(freezeEl)
            try { document.getAnimations().forEach((a) => a.pause()) } catch {}
        } else {
            if (freezeEl) freezeEl.remove()
            freezeEl = null
            try { document.getAnimations().forEach((a) => a.play()) } catch {}
        }
    }

    async function commit() {
        if (!draft) return
        const text = (draft.text || '').trim()
        if (!text) return
        if (draft.editing) {
            const j = await api('/queue', { action: 'update', id: draft.editing, patch: { comment: text, intent, severity } })
            draft = null; intent = severity = null; popPos = null
            list = j.annotations || list
            render()
            return say('Updated')
        }
        const rec = Object.assign({}, draft.rec, { comment: text, intent, severity })
        const hadShot = !!draft.shot
        const j = await api('/queue', { action: 'add', annotation: rec, shot: draft.shot })
        draft = null; intent = severity = null; popPos = null
        if (j.error) { render(); return say(j.error) }
        list = j.annotations || []
        render()
        say(hadShot ? 'Added, with a screenshot' : 'Added')
    }

    async function send() {
        const j = await api('/queue', {
            action: 'export', agent: settings.agent, target: settings.target,
            model: settings.model, brief: settings.brief,
        })
        if (j.error) return say(j.error)
        try { await navigator.clipboard.writeText(`Read ${j.file} and follow .laminator/review-ui.md`) } catch {}
        say(j.launch && j.launch.ok
            ? `${j.count} handed to ${settings.agent}`
            : `Wrote ${j.file} — prompt copied (${(j.launch && j.launch.how) || 'nothing opened'})`, 7000)
    }

    /* ────────────────────────────── input ──────────────────────────────── */

    addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
            e.preventDefault(); open = !open; if (open) pull(); render(); return
        }
        if (!open) return
        if (e.key === 'Escape') {
            if (draft) { draft = null; popPos = null; intent = severity = null }
            // In multi, Escape drops the SELECTION first and the mode second.
            // One key discarding six deliberate clicks is the wrong kind of
            // decisive.
            else if (mode === 'multi' && picked.length) picked = []
            else if (mode) mode = null
            else if (panel) panel = null
            else open = false
            render(); return
        }
        const tag = e.target && e.target.tagName
        if (draft || tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return
        if (e.metaKey || e.ctrlKey || e.altKey) return
        const k = e.key.toLowerCase()
        const m = { e: 'element', t: 'text', a: 'area' }[k]
        if (m) { e.preventDefault(); mode = mode === m ? null : m; picked = []; render() }
        else if (k === 'm') { e.preventDefault(); if (mode === 'multi') finishMulti(); else { mode = 'multi'; render() } }
        else if (k === 'p') { e.preventDefault(); paused = !paused; applyFreeze(); render() }
    })

    addEventListener('mousemove', (e) => {
        if (!open || !mode || draft || mode === 'area') return
        const t = e.target
        if (!(t instanceof Element) || OURS(t)) { if (hover) { hover = null; render() } return }
        const b = t.getBoundingClientRect()
        hover = { left: b.left, top: b.top, width: b.width, height: b.height }
        render()
    }, true)

    addEventListener('click', async (e) => {
        if (!open || draft) return
        if (mode !== 'element' && mode !== 'multi') return
        const t = e.target
        if (!(t instanceof Element) || OURS(t)) return
        e.preventDefault(); e.stopPropagation()
        if (mode === 'multi') {
            picked = picked.indexOf(t) >= 0 ? picked.filter((x) => x !== t) : picked.concat([t])
            return render()
        }
        await beginDraft(t, { mode: 'element' })
    }, true)

    // Text selection.
    addEventListener('mouseup', (e) => {
        if (!open || mode !== 'text' || draft) return
        if (e.target instanceof Element && OURS(e.target)) return
        // Deferred a tick: on mouseup the selection is not committed yet, so
        // reading it here returns the PREVIOUS one.
        setTimeout(async () => {
            const sel = getSelection()
            const text = sel && sel.toString().trim()
            if (!sel || !text || sel.isCollapsed) return
            const node = sel.anchorNode
            const el = node instanceof Element ? node : node && node.parentElement
            if (!el || OURS(el)) return
            await beginDraft(el, { selectedText: text.slice(0, 400), mode: 'text' })
        }, 0)
    }, true)

    // Region drag.
    addEventListener('pointerdown', (e) => {
        if (!open || mode !== 'area' || draft) return
        if (e.target instanceof Element && OURS(e.target)) return
        e.preventDefault()
        dragFrom = { x: e.clientX, y: e.clientY }
    }, true)
    addEventListener('pointermove', (e) => {
        if (!dragFrom) return
        rubber = {
            x: Math.min(dragFrom.x, e.clientX), y: Math.min(dragFrom.y, e.clientY),
            width: Math.abs(e.clientX - dragFrom.x), height: Math.abs(e.clientY - dragFrom.y),
        }
        render()
    }, true)
    addEventListener('pointerup', async (e) => {
        if (!dragFrom) return
        const f = dragFrom; dragFrom = null
        const area = {
            x: Math.min(f.x, e.clientX), y: Math.min(f.y, e.clientY),
            width: Math.abs(e.clientX - f.x), height: Math.abs(e.clientY - f.y),
        }
        // A stray click is not a region: below this the container lookup returns
        // whatever is under the cursor, which is element mode with extra steps.
        if (area.width < 12 || area.height < 12) { rubber = null; return render() }
        await beginDraft(containerFor(area), { area, members: inside(area), mode: 'area' })
    }, true)

    const reflow = () => { if (open) render() }
    addEventListener('scroll', reflow, true)
    addEventListener('resize', reflow)

    // The queue is shared with whatever agent is working it, so it is polled
    // rather than fetched once — that is what makes a pin go grey while you
    // watch instead of only after a reload.
    setInterval(() => { if (open) pull() }, 3000)

    console.log('%c laminator %c ' + CFG.project.name + ' — Ctrl/Cmd+Shift+F',
        'background:#2f6df6;color:#fff;border-radius:3px', '')
})()
