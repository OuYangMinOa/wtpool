# wtpool: a pool of warm git worktrees

**English** | [繁體中文](README.zh-TW.md)

When you work on several branches at once, or run several coding agents in parallel, every new worktree
has to reinstall `node_modules` and rebuild from scratch, which often takes longer than the change itself.
wtpool keeps a fixed set of worktrees for a repo. They sit on the base branch with dependencies and build output
in place; when a task starts you take an idle one and branch off, and when it's done you put it back, so the next
task starts warm.

- **CLI**: `skills/wtpool/scripts/wtpool.mjs`, Node 18+, zero dependencies, runs on Windows, macOS and Linux.
- **Agent skill**: `skills/wtpool` follows the [Agent Skills](https://agentskills.io) format and carries the CLI
  with it. It tells the agent to `take` before starting work, `release` when done, and ask you before growing the
  pool. Works with Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Claude Code and other agents that read skills.
- **Claude Code plugin**: the skill plus hooks that take over Claude Code's built-in worktrees (`claude --worktree`,
  `EnterWorktree`, subagents with `isolation: worktree`, background sessions) and serve them from the pool.

## Install

### Claude Code plugin

In Claude Code, type:

```
/plugin install wtpool --marketplace OuYangMinOa/wtpool
```

Answer `y` when asked to add the marketplace, then pick a scope (see the recommendation below). Or from a terminal:

```
claude plugin install wtpool --marketplace OuYangMinOa/wtpool --scope local
```

**Install it at project or local scope**, only in repos that have a `.wtpool.json`. Once enabled, the plugin's
hooks replace Claude Code's own worktree creation entirely. In a repo without `.wtpool.json` they still create
worktrees the way Claude Code does (`.claude/worktrees/<name>` on branch `worktree-<name>`), but Claude Code's
periodic cleanup no longer applies, so worktrees left behind by subagents have to be cleaned up by hand.

To have everyone who clones a repo get the plugin automatically, add this to the repo's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "wtpool": { "source": { "source": "github", "repo": "OuYangMinOa/wtpool" } }
  },
  "enabledPlugins": { "wtpool@wtpool": true }
}
```

When developing the plugin itself, load it straight from the folder with `claude --plugin-dir <path to wtpool>`.

### Other agents (Codex, Cursor, Gemini CLI, Copilot, …)

```
npx skills add OuYangMinOa/wtpool
```

[skills](https://github.com/vercel-labs/skills) finds the coding agents you have and installs the skill for them, in
the project by default (`.agents/skills/`, or `.claude/skills/` for Claude Code); add `-g` to install it for all
your projects. The CLI comes inside the skill, so Node 18+ is all you need. You can also copy the `skills/wtpool`
folder into your agent's skills folder by hand. In Claude Code, install the plugin instead: it has the same skill
plus the hooks.

Other agents get no hooks; their own worktree features keep creating fresh worktrees outside the pool. The skill
has them run `wtpool take` / `release` instead.

### Agents without skills: `AGENTS.md`

For agents that don't read skills, or to make sure every agent working in a repo knows about the pool, install the
CLI (below) and add a note to the repo's `AGENTS.md` (or `CLAUDE.md`):

```markdown
## Worktrees

This repo uses wtpool (see `.wtpool.json`). Before working on a new branch, run `wtpool take <branch>` and do all
the work in the path it prints; don't edit the main checkout or run `git worktree add`. Once the branch is merged,
run `wtpool release`. If `take` exits with code 2, every worktree is busy: ask before running `wtpool add`.
```

### CLI only

```
npm install -g github:OuYangMinOa/wtpool   # gives you the wtpool command
# or clone the repo and run it directly
node wtpool/skills/wtpool/scripts/wtpool.mjs status
```

## Getting started

Inside a repo:

```
wtpool init        # writes .wtpool.json (guessing the base branch and install commands) and creates the worktrees
```

Check that `base` and `setup` in `.wtpool.json` are right, then commit it so everyone who clones the repo can use it.

```
wtpool take feature/login           # take an idle worktree, create the branch, print its path on stdout
cd "$(wtpool take feature/login)"   # or jump straight into it
wtpool status                       # what every worktree is doing
wtpool release w2                   # put it back when done (w2 can be omitted from inside that worktree)
wtpool sweep                        # put back every worktree whose branch has been merged
```

## Configuration: `.wtpool.json`

Lives at the repo root, for example:

```json
{
  "base": "origin/dev",
  "dir": "../myapp-worktrees",
  "name": "worktree_w{n}",
  "size": 3,
  "copy": [".env"],
  "setup": [
    {
      "run": "npm ci --no-audit --no-fund",
      "cwd": "frontend",
      "watch": ["frontend/package-lock.json"],
      "ifMissing": "frontend/node_modules"
    }
  ]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `base` | origin's default branch | New branches start here and released worktrees go back here. `take` and `release` run `git fetch` first |
| `dir` | `../{repo}-worktrees` | Where the worktrees live, relative to the repo root; `{repo}` is the repo's folder name |
| `name` | `w{n}` | Folder name of each worktree, `{n}` being its number. Match an existing naming scheme to adopt worktrees you created by hand |
| `size` | `2` | How many worktrees `wtpool init` creates |
| `setup` | `[]` | Preparation steps, see below |
| `copy` | `[]` | Files copied from the main checkout into each worktree. Only gitignored files (such as `.env`) are copied, so worktrees stay clean |
| `hookBranch` | `wt/{name}` | Branch name used when Claude Code's built-in worktrees are served from the pool; `{name}` is the name Claude Code passes |
| `staleAfterHours` | `24` | A taken worktree with no commits for this long shows as "maybe unused" in `status`, and `sweep --stale` puts it back |

### Setup steps

Each step is `{ "run", "cwd", "watch", "ifMissing" }`, or just a command string:

- `run`: the command, run through the system shell (cmd.exe on Windows). `WTPOOL_SLOT` (the number) and
  `WTPOOL_PATH` are set in its environment.
- `cwd`: the subdirectory to run it in; defaults to the repo root.
- `watch`: rerun only when these files differ between the old and new commit (usually lockfiles).
- `ifMissing`: rerun when this path doesn't exist (usually `node_modules`).

New worktrees, and worktrees whose last preparation failed, run every step. Otherwise only the steps whose
`watch` or `ifMissing` condition holds are run; a step with neither runs once, when the worktree is created.

## States

`status` shows the label; `status --json` also gives the language-neutral `state` key.

| `state` | Label | Meaning | Does `take` use it? |
| --- | --- | --- | --- |
| `idle` | idle | On the base branch (detached), no changes | Yes |
| `done` | reclaimable | Its branch has been merged into the base, no changes | Yes (the branch is kept) |
| `busy` | in use | Taken, or has uncommitted changes | No |
| `stale` | maybe unused | Taken longer than `staleAfterHours` with no commits | No; `sweep --stale` puts it back |
| `warming` | preparing | Installing dependencies | No |
| `missing` | missing | Its directory was deleted | No; clean it up with `git worktree prune` |

A take is recorded in the worktree's git admin directory (`.git/worktrees/<id>/wtpool.json`) and the worktree is
locked with `git worktree lock`, so `git worktree remove` / `prune` won't delete it by accident. Picking a worktree
happens under a mutex, so several sessions running `take` at once never get the same one.

## Commands

| Command | What it does |
| --- | --- |
| `init [count]` | Writes `.wtpool.json` if missing, then creates worktrees up to `count` (default: `size`) |
| `status [--json]` | Lists every worktree and its state |
| `take <branch> [--slot wN] [--from <ref>]` | Takes an idle worktree and creates the branch, printing only the path on stdout. An existing branch is checked out; a branch that exists only on origin continues from origin |
| `release [wN\|branch\|path] [--stash]` | Puts a worktree back: switches to the base branch and refreshes dependencies, keeping the branch. Refuses if there are uncommitted changes; `--stash` stashes them first |
| `add [count]` | Adds more worktrees |
| `remove <wN>` | Removes an idle worktree (deletes its directory) |
| `refresh` | Moves idle worktrees to the latest base branch and refreshes dependencies |
| `sweep [--stale]` | Puts back worktrees whose branch has been merged; `--stale` also puts back "maybe unused" ones |
| `which` | Shows which worktree the current directory is in |
| `hook create\|remove` | For Claude Code's hooks; reads JSON on stdin, see below |

Common flags: `--no-fetch` skips the fetch, `--quiet` hides progress output.

Exit codes: `0` success, `1` error, `2` no idle worktree.

## Language

The CLI speaks English and Traditional Chinese. Set `WTPOOL_LANG` to choose:

```
WTPOOL_LANG=en wtpool status       # English
WTPOOL_LANG=zh-TW wtpool status    # 繁體中文 (zh and zh_TW work too)
```

Without it, wtpool follows the system language: the display language on Windows (Git Bash always sets `LANG` to
`en_US`, so it isn't used there), and `LC_ALL` / `LC_MESSAGES` / `LANG` elsewhere. Anything other than Chinese means English.

To pick the language for the Claude Code hooks as well, set it in the `env` block of your Claude Code settings:

```json
{ "env": { "WTPOOL_LANG": "en" } }
```

## Claude Code integration

The plugin registers two command hooks in `hooks/hooks.json`, `WorktreeCreate` and `WorktreeRemove`:

- **Create** (`wtpool hook create`):
  - With `.wtpool.json`: takes an idle worktree, creates a `wt/<name>` branch and returns its path, installing
    dependencies first if needed. When every worktree is busy it creates one the way Claude Code does, in
    `.claude/worktrees/<name>`; the pool never grows on its own.
  - Without `.wtpool.json`: creates the worktree the way Claude Code does, in `.claude/worktrees/<name>` on branch
    `worktree-<name>`, and copies the files listed in `.worktreeinclude` (plain paths, plus wildcards at the root level).
- **Remove** (`wtpool hook remove`):
  - A pool worktree is put back rather than deleted: uncommitted changes go to `git stash`, a `wt/*` branch with no
    commits is deleted while one with commits is kept, and dependencies are refreshed in the background.
  - A worktree under `.claude/worktrees/` is deleted the way Claude Code does it. Uncommitted changes are stashed
    first, and its branch is deleted only if it has been merged.

Why not a plugin hooks module (`hooks.modules`): with Claude Code 2.1.318, the built-in security module doesn't let
user-level hooks modules take over `WorktreeCreate`, and `claude --worktree` creates its worktree before hooks
modules load. Only command hooks work. The cost is that a command hook can't hand a request back to Claude Code,
which is why wtpool reproduces Claude Code's own behavior for the cases above.

Note: Claude Code doesn't call `WorktreeRemove` when a subagent or workflow finishes. Put those worktrees back with
`wtpool sweep` (after the branch is merged) or `wtpool sweep --stale` (no commits, left for a long time).

## Development

```
npm test        # node --test; builds throwaway repos with a local bare origin and runs the real CLI
claude plugin validate .
```

GitHub Actions runs the tests on Windows, macOS and Linux with Node 18 and 22.
