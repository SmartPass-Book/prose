# Issue tracker: bd (beads)

Issues and specs for this repo live in **bd (beads)**, a local Dolt-backed tracker in `.beads/`. Use the `bd` CLI for all operations. Do NOT use GitHub Issues, TodoWrite, TaskCreate, or markdown TODO lists - this repo tracks everything in bd.

Issue IDs are prefixed `prose-` (e.g. `prose-q6p`). Run `bd prime` for the full workflow context.

## Conventions

- **Create an issue**: `bd create --title "..." --description "..." --type=task|bug|feature|epic|chore --priority=2`.
  Priority is `0-4` (0 = critical, 2 = medium, 4 = backlog), never "high"/"low".
  Use `--body-file -` or `--stdin` for multi-line descriptions.
  Add `--acceptance "..."`, `--design "..."`, `--notes "..."` where the skill has that material.
  `--silent` prints only the new ID, for scripting.
- **Read an issue**: `bd show <id>`, or `bd show <id> --json --include-comments` when you need structured output with comment bodies.
- **List issues**: `bd list --status=open --json`. Filter with `--label`, `--label-any`, `--exclude-label`, `--type`, `--priority`, `--parent`.
- **Find available work**: `bd ready` (open, unblocked, not deferred). `bd blocked` for the inverse.
- **Comment on an issue**: `bd comment <id> "..."` (or `--file` / `--stdin`).
- **Apply / remove labels**: `bd label add <id> <label>` / `bd label remove <id> <label>`.
- **Claim**: `bd update <id> --claim`. Assign explicitly with `bd update <id> --assignee=<name>`.
- **Update fields**: `bd update <id> --title/--description/--notes/--design`.
  Never run `bd edit` - it opens `$EDITOR` and blocks the agent.
- **Close**: `bd close <id> --reason "..."`. Close several at once: `bd close <id1> <id2>`.
- **Search**: `bd search <query>`.
- **Dependencies**: `bd dep add <issue> <depends-on>` (the first is blocked by the second), or `--deps 'blocks:prose-xxx'` at create time.
- **Hierarchy**: `bd create --parent <id>` for a child issue.

Writes land in the local Dolt working set. Push with `bd dolt push` as part of the session close protocol in `CLAUDE.md`.

## Pull requests as a request surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Run `bd create`.

## When a skill says "fetch the relevant ticket"

Run `bd show <id> --json --include-comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: `bd create --type=epic --labels wayfinder:map --title "..."`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `bd create --parent <map-id> --labels wayfinder:<type>`, where `<type>` is `research`, `prototype`, `grilling`, or `task`. Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: `bd dep add <child> <blocker>`. `bd blocked` lists blocked issues; a ticket is unblocked when every blocker is closed.
- **Frontier query**: `bd ready --parent <map-id> --json`, dropping any ticket that already has an assignee; first in map order wins.
- **Claim**: `bd update <id> --claim` - the session's first write.
- **Resolve**: `bd comment <id> "<answer>"`, then `bd close <id>`, then append a context pointer to the map's Decisions-so-far via `bd update <map-id> --notes`.
