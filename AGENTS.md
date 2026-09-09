# Laminator, for your coding agent

Copy this file into any project that uses Laminator, as `AGENTS.md`, or paste it
into `CLAUDE.md`, `.cursorrules`, or whatever your agent reads. It tells the
agent what Laminator is and how to work its queue.

---

## What Laminator is

The person you are working with can point at anything in their running app and
leave a note on it. Laminator turns that click into a record that already
contains where the thing is, what paints it, and usually the exact file and line
to edit. You do not have to find it.

It runs entirely on their machine: a small HTTP server on `127.0.0.1:7317`, and
an overlay in their browser. There is no cloud, no account, and no service to
call.

## How to know it is there

```bash
curl -s http://127.0.0.1:7317/health
```

A JSON reply means it is running. If it refuses, Laminator is not started. Say
so instead of guessing at UI problems, and offer `npx laminator`.

There will also be a `.laminator/` directory in the project root containing
`config.json` (what the scan learned), `review-*.md` (exported batches) and
`review-ui.md` (the full working instructions, generated for this project).

## Working the queue

Read `.laminator/review-ui.md` first. It is generated per project and names that
project's own test, lint and typecheck commands. What follows is the short
version.

### 1. Read the live queue rather than a snapshot

```bash
curl -s http://127.0.0.1:7317/queue
```

Work only findings whose `status` is `pending` or `acknowledged`. An empty queue
means there is nothing to do, so do not go looking for UI problems of your own.

### 2. Read `laminator.styling` before you go hunting

| `styling` | What it means | Where to edit |
| --- | --- | --- |
| `rule` | `laminator.rule` carries a real `file:line` | That line. Check `siblings` first: it says how many elements the rule paints, and an edit moves all of them. |
| `utility` | Utility classes (Tailwind or similar). There is no rule. | The `class` attribute. `cssClasses` lists them; `reactComponents` names the component. |
| `none` | CSS module, `<style>` block, or CSS-in-JS | Search the source for the listed classes. |

Other fields worth using:

- `boundingBox`, `computedStyles` and `misaligned` were measured in the live DOM.
  If `misaligned` says 2.4px, it is 2.4px.
- `screenshot`, when present, is a real PNG of that element in the real page
  state. Read the image. It is the only field that can answer "does this actually
  look wrong", and a complaint phrased as a feeling usually needs it.
- `laminator.paused: true` means animations were frozen deliberately, so a
  complaint about a mid-animation frame is intentional.
- `laminator.members` on a multi-element or region finding lists the others.
- A "Standing context from the owner" block at the top of a review file outranks
  your own reading of the code. It is the one part written by a person.

Respect `severity` (`blocking` → `important` → `suggestion`) and `intent`:
`question` wants an answer in the thread rather than a change; `approve` wants
nothing.

### 3. Close each finding as you go, one at a time

This is the part people notice. Resolving a finding greys out its pin in their
browser within three seconds, so they watch the list drain while you work. Do not
batch the resolves to the end.

```bash
# say what you did; this lands in the finding's thread
curl -s -X POST -H "content-type: application/json" \
  -d '{"action":"reply","id":"<ID>","role":"agent","content":"<one line: what changed, and where>"}' \
  http://127.0.0.1:7317/queue

# then close it
curl -s -X POST -H "content-type: application/json" \
  -d '{"action":"update","id":"<ID>","patch":{"status":"resolved","resolvedBy":"agent"}}' \
  http://127.0.0.1:7317/queue
```

- Decided against a change? Use `"status":"dismissed"` and put the reason in the
  reply. Never resolve something you did not act on. A queue that drains without
  the problems going away is worse than no queue.
- Ambiguous? Reply with the question and set `"status":"acknowledged"`.

### 4. House rules

- Both themes. If the project has a dark mode, check for a `prefers-color-scheme`
  block as well as a `[data-theme]` block. Many projects define the same token
  twice and only one gets updated.
- `siblings > 1` moves other elements. If the fix should only affect the one you
  were shown, add a class rather than editing the shared rule, and say so.
- Prefer the project's own tokens to new literal values. Look at what
  neighbouring rules use before introducing a number.
- The project's own `CLAUDE.md`, `AGENTS.md` or `CONTRIBUTING.md` outranks this
  file.

### 5. Finish

A short list: what you changed with `file:line`, what you dismissed and why, and
anything left open as a question. Then run the project's typecheck, lint and
tests. `.laminator/review-ui.md` names them.

## Other endpoints

| Call | Use |
| --- | --- |
| `POST /rules` `{"tokens":[".card"]}` | Which rules could paint an element with these classes |
| `POST /css` `{"file","line","property","value"}` | Change one declaration. Allowlisted files only, no free-text writes. |
| `GET /config` | What the scan found: frameworks, styling, editable stylesheets |
| `POST /queue` `{"action":"savings"}` | What the tool has cost and avoided, in bytes |

## Things that are true and easy to get wrong

- Nothing can type into a terminal that is already running. If the person asks
  you to "send it to my open terminal", the honest answer is Copy-only plus a
  paste, or a new window carrying an existing conversation.
- CSS modules have no usable anchor. Their class names are hashed at build time,
  so Laminator reports `none` for them instead of inventing a line.
- The scan can be stale. If a line looks wrong the stylesheet moved. Say so and
  suggest `npx laminator scan` before editing the wrong place.
