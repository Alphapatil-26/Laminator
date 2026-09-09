---
description: Work the UI review queue captured by laminator — fix each finding and resolve it live, so the pins grey out on the owner's screen as you go
argument-hint: [path to a .laminator/review-*.md, or nothing to take the live queue]
---

You are working a batch of UI findings captured in the running **{{PROJECT}}**
app. Each one was made by pointing at something on screen, so each carries where
it is, what paints it, and often the exact file and line to edit.

This project: **{{FRAMEWORKS}}** · styling: **{{STYLING}}** · source under {{SOURCE_ROOTS}}.

**The queue is two-way.** Resolving a finding through the API greys out its pin
in the owner's browser within seconds. That is the point — they watch the list
drain while you work instead of waiting for a summary. Do not batch the resolves
to the end.

## 1. Read the queue

Prefer the LIVE queue; the review file is a snapshot that may be minutes old.

```bash
curl -s http://127.0.0.1:{{PORT}}/queue
```

Work only findings whose `status` is `pending` or `acknowledged`. If the server
is not running, read the markdown file passed as this command's argument, or the
newest one:

```bash
ls -t .laminator/review-*.md | head -1
```

If both are empty, say so and stop. **Do not go looking for UI problems of your
own** — an empty queue means there is nothing to do, not that you should invent
work.

## 2. Understand what each record is telling you

Read `laminator.styling` first, because it says where the style actually lives and
the three cases need different work:

| `styling` | What it means | Where to edit |
| --- | --- | --- |
| `rule` | `laminator.rule` carries a real `file:line` | That line. Check `siblings` first — it says how many elements the rule paints, and an edit moves all of them. |
| `utility` | Utility classes (Tailwind or similar). There is no rule. | The `class` attribute in the markup. `cssClasses` lists them; `reactComponents` names the component if it could be read. |
| `none` | A rule exists somewhere the scan cannot write — a CSS module (hashed names), a `<style>` block, or CSS-in-JS | Search the source for the classes listed. |

Other fields worth using: `elementPath` is the live DOM path, `computedStyles`
are what the browser actually resolved, and `boundingBox` was measured, not
estimated. If the record has a `screenshot` path, **read that image** — it is the
element as it really looked, and it is the only field that can answer "does this
actually look wrong".

If the review file opens with **"Standing context from the owner"**, that
outranks your own reading of the code. It is the one part written by a person
rather than measured by the tool.

Respect `severity`: `blocking` first, then `important`, then `suggestion`. And
respect `intent` — `question` wants an answer in the thread, not a code change;
`approve` wants nothing at all.

## 3. Fix, then close it out — one at a time

After each fix, before moving on:

```bash
# Say what you did — this lands in the finding's thread
curl -s -X POST -H "content-type: application/json" \
  -d '{"action":"reply","id":"<ID>","role":"agent","content":"<one line: what changed and where>"}' \
  http://127.0.0.1:{{PORT}}/queue

# Then close it
curl -s -X POST -H "content-type: application/json" \
  -d '{"action":"update","id":"<ID>","patch":{"status":"resolved","resolvedBy":"agent"}}' \
  http://127.0.0.1:{{PORT}}/queue
```

For anything you decide NOT to change, use `dismissed` instead of `resolved` and
put the reason in the reply. **Never resolve something you did not act on** — a
queue that drains without the problems going away is worse than no queue.

If a finding is ambiguous, reply with the question and set `acknowledged`.

## 4. House rules

- **Both themes.** If this project has a dark mode, every visual change must be
  right in both. Check for a `prefers-color-scheme` block AND a `[data-theme]`
  block — many projects define the same token twice and only one gets updated.
- **A rule with `siblings > 1` moves other elements.** If the fix should only
  affect the one you were shown, add a class rather than editing the shared
  rule, and say so in the reply.
- **Prefer the project's own tokens** over new literal values. Look at what
  neighbouring rules use before introducing a number.
- Read the project's own `CLAUDE.md`, `AGENTS.md` or `CONTRIBUTING.md` if present
  — they outrank anything here.

## 5. Report

Finish with a short list: what you changed (with `file:line`), what you dismissed
and why, and anything you left open as a question. Then run what covers it:

```
{{TYPECHECK}}
{{LINT}}
{{TEST}}
```
