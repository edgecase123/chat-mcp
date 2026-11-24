---
title: The settings modal
updated: 2026-11-24
covers:
  - web/index.html
  - web/assets/app.js
  - web/assets/logic.js
  - web/assets/style.css
---

# The settings modal

Where operator configuration lives in the dashboard, and why it is a modal
rather than a sidebar card or a second page.

---

## Why it is not in the sidebar

The sidebar says what is true right now. Its sections — Claims, Agents, Peers,
Rooms, Discover — are read-outs, and `renderSidebar()` destroys and rebuilds
all of them on any peer status change.

A form in that panel is therefore wiped mid-use by an event the operator did
not cause. The registration form worked around this by mirroring every
keystroke into `state.registrationDraft`. Four other pieces of state exist for
the same reason. See [#399](https://github.com/edgecase123/chat-mcp/issues/399).

🛑 **The modal is outside `renderSidebar()`'s path, and that is the point.**
`settings-wiring.test.ts` asserts `renderSidebar()` never names it.

## Why it is not a page

The dashboard is a single view with a live event stream. Navigating away drops
the stream, so a config _page_ would cost the operator the thing they are
watching.

## The tabs are a list

`SETTINGS_TABS` in `web/assets/logic.js` is the single source. The strip and
the panels are built by mapping it.

```js
export const SETTINGS_TABS = [
  { id: "agents", label: "Agents" },
  { id: "rooms", label: "Rooms" },
];
```

🛑 **Adding a tab is one entry in that list and nothing else** — no markup, no
CSS. lee ruled two tabs on 2026-11-22 with a third to follow, so this is
enforced rather than intended:

| guard                                          | in                        |
| ---------------------------------------------- | ------------------------- |
| the CSS names no tab and no count              | `settings-tabs.test.ts`   |
| `index.html` hardcodes no tab button           | `settings-wiring.test.ts` |
| the strip maps the list, with no literal label | `settings-wiring.test.ts` |

`settingsTabSelection()` picks the open tab and falls back to the first entry
for an unknown id, so a renamed tab opens the modal rather than a blank box.

## What is on each panel

`SETTINGS_PANEL_BUILDERS` in `web/assets/app.js` maps a tab id to the builder
that fills its panel. It is the same shape as `SECTION_BUILDERS`, for the same
reason: the lookup is data, so adding a panel is a row rather than a branch in
the renderer.

| tab      | panel                                                                         |
| -------- | ----------------------------------------------------------------------------- |
| `agents` | `agentsPanel()` — two groups: the registrations, then the global gate default |
| `rooms`  | no builder yet, so the placeholder                                            |

🛑 **A tab with no builder is supported, not broken.** The lookup is optional
(`SETTINGS_PANEL_BUILDERS[active]?.()`) and falls back to the placeholder. A
plain call would be a `TypeError` that takes the whole strip down with it, which
is the one thing lee's "a new tab is one list entry" ruling cannot survive.

## Repainting the panel

🛑 **Eight handlers repaint the panel, and `repaintSettings()` is the only way
they do it.** Their controls used to live in the sidebar, so each one used to
call `renderSidebar()`.

```
submitRegistration  the invalid-input path, and the tail
forgetRegistration  the tail
openPlan            the close path, the busy paint, and the tail
approvePlan         the busy paint, and the tail
```

🛑 **`setGate` repaints the dialog AND the sidebar**, for either scope. The
global default is the layer every non-overridden row resolves through, so a
change here moves their numbers and their gauge colours too. See
[context-gate.md](../05-supervision/context-gate.md).

🛑 **The argument is `state.settingsTab`, never `null`.**
`settingsTabSelection(null)` resolves to the FIRST tab, so a null would pull an
operator who is on `Rooms` back to `Agents` mid-action.

⚠️ **`null` passes every behavioural test today by coincidence**, because
`agents` is both the first tab and the tab these controls sit on. That is why
`settings-wiring.test.ts` pins the argument as source text instead.

⚠️ **`registrationEpoch` is gone.** It existed to force a sidebar section
rebuild when `registrations` was byte-identical, and the panel now repaints
unconditionally with no signature gate to satisfy.

## The dialog is native

`<dialog>` with `showModal()`, so the focus trap, the backdrop and Esc are the
platform's. There was no modal in this UI to copy that behaviour from, and a
`class="is-open"` box lets Tab walk out into the page behind it.

## Common pitfalls

⚠️ **`[hidden] { display: none !important }` in `style.css` is load-bearing**
for the rest of the app, because `.app-shell` and `.loading` both set
`display: grid` and would otherwise override the UA rule. A `<dialog>` is
hidden by the UA until opened and needs no such help.

---

## Source files

| File                   | Role                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `web/index.html`       | the opener button, and the dialog's head, strip and panel container                             |
| `web/assets/logic.js`  | `SETTINGS_TABS` and `settingsTabSelection()` — the decisions, DOM-free                          |
| `web/assets/app.js`    | `renderSettings()`, `SETTINGS_PANEL_BUILDERS`, `repaintSettings()`, the open and close handlers |
| `web/assets/style.css` | `.settings*` — keyed to no tab count and no tab id                                              |

## Related docs

- [stopping-agents.md](stopping-agents.md) — another dashboard operator action
