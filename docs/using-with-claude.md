# Using Helix Dev Tool with Claude (project instructions)

Paste the block below into the **project instructions** of any Claude project that sometimes needs to look
at BMC Helix / AR System definitions. Replace the two `<…>` placeholders.

Why files and not a live link: Claude in another project may not be able to reach `localhost` on your
computer, but it can always read a folder. Helix Dev Tool exports definitions to a folder you choose, with
a short manifest next to each export, so Claude never needs the tool to be running.

---

## Paste this

```text
# Helix definitions (BMC Helix ITSM / AR System)

Some work in this project depends on how the existing BMC Helix ITSM (AR System) environment is defined: field
IDs and names, form structure, workflow (active links, filters, escalations), menus, permissions. That information
lives in definition files exported with a local tool called Helix Dev Tool.

## Where they are
Exports are in: <FULL PATH TO THE EXPORT FOLDER>
Each export is one or more definition files plus a manifest with the same base name:
  <Instance>_<what>_<YYYY-MM-DD>.def          (or -part1of3.def, -part2of3.def … when large; or .xml)
  <Instance>_<what>_<YYYY-MM-DD>.manifest.md  (read this FIRST)
The instance in the file name is where it came from (for example Dev or Prod). Prefer the newest export of the
thing you need and say which file you used. If what you need is not there, ask me to export it (see below);
do not guess.

## Read the manifest first
It states the source instance, when it was exported, the scope, every object in the files, how many definitions
are really in them, and the forms the objects depend on (and, for a promotion, which of those do not exist on the
target). Objects that exist on only one side of a comparison were exported from the source side.

## Reading a .def file
- Plain UTF-8 text. A header (`char-set: UTF-8`, `File exported <date>`), then objects.
- Each object is `begin <type>` … `end`. Types you will see: `schema` (a form, including all its fields and
  views), `active link`, `filter`, `escalation`, `char menu`, `container` (guides, applications, packing lists).
- Inside, simple properties are 3-space-indented `key : value` lines: `name`, `owner`, `last-changed` (who),
  `timestamp` (seconds since 1970), `enable`, and for workflow the order (`actlink-order`, `filter-order`).
- `schema-name : <form>` lines, repeated, list the forms a workflow object is attached to. Shared workflow can
  be attached to hundreds of forms; that is normal.
- Nested `{ … }` blocks hold structure: `field { … }` and `vui { … }` (views) inside a form, `action { … }` in
  workflow.
- Conditions and actions use BMC's compact encoding: backslash-separated values that refer to fields by NUMERIC
  ID, e.g. `set-field : 0\1714000\102\…`. Resolve IDs to names with the form's own definition, where each field
  has `id : <n>` and `name : <label>`.
- Overlays: an object named `<name>__o` is the overlay of `<name>`. Both are exported together; an overlay
  needs its base object wherever it is imported.
- A form definition is large (megabytes). Search it (for example for `id : 1714000`) instead of reading it all.

## Rules
- These are READ-ONLY references. Never present a change as applied to the Helix server; you cannot change it.
  Importing definitions into an environment is done by me with the normal BMC process.
- Field IDs, form names and object names are exact and case-sensitive (forms contain colons and spaces).
  Quote them exactly as they appear in the file.
- If two instances disagree (Dev vs Prod), say which instance each statement comes from.
- The files can contain customer data and internal logic. Keep them in this project; do not paste them into
  anything shared without asking me.

## When you need something that isn't in the folder
Ask me to export it from Helix Dev Tool and tell me exactly what, for example:
  - one object:      Workflow page → open the object → "Export .def…" → Save to folder
  - a form's whole workflow (and optionally the form definition): Workflow page → pick the form →
    "Export this form's workflow…"
  - what differs between environments: Workflow compare → run the comparison → "Export .def…"
    (objects only on Dev and/or different; the manifest lists forms missing on the target)
  - what changed recently: Recent changes → "Export .def…"
For a human-readable summary instead of raw definitions, the tool also produces Markdown reports (Workflow
compare → "Report (.md)", Form layout compare, Recent changes), which show conditions and actions in plain
text with field names resolved.
```

---

## Optional: live read-only access

If Claude *can* reach `http://localhost:3001` (the app must be open, and the instance's gateway running), these
read-only endpoints answer without any file export. If a request cannot connect, fall back to the folder.

Add this to the block above if it works in your setup:

```text
## Live lookups (only if http://localhost:3001 is reachable; otherwise use the folder)
GET /api/connections                                   → instances (names/ids; never passwords)
GET /api/workflow/<id>/forms                           → all form names on that instance
GET /api/workflow/<id>/form-workflow?form=<name>       → names of the active links, filters, escalations on a form
GET /api/workflow/<id>/object?kind=<activeLink|filter|escalation>&name=<name>
                                                       → one object, readable (run-if, actions, forms) plus raw
GET /api/workflow/<id>/search?kind=<kind>&q=<text>     → find objects by name
GET /api/workflow/<id>/recent?days=7                   → what changed recently, and by whom
GET /api/workflow/<id>/layout/views?form=<name>        → a form's views
These are read-only. Do not call any POST/PUT/DELETE endpoint without asking me.
```

## Notes for whoever maintains this

- The export folder is set once in the tool (any export dialog → *Export folder*). Point it at the Claude
  project's folder if you want exports to appear there directly.
- Exports use the server's own export call, so the files are the same format Dev Studio's *Export* and
  `arexport` produce. The tool never imports anything.
- Exporting changes nothing on the server.
