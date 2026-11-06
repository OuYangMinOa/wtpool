---
name: wtpool
description: Use before changing code in a git repo that has a .wtpool.json file (a new feature, a bug fix, any work on its own branch). Take a pre-warmed worktree from the pool and branch off there, instead of editing the main checkout or running git worktree add yourself. Also use it to put a finished branch back, to check what the pool's worktrees are doing, when every worktree is busy, or when the user wants to set up a worktree pool for a repo.
license: MIT
compatibility: Needs git and Node.js 18 or later.
---

# wtpool: a pool of warm git worktrees

A repo with a `.wtpool.json` at its root keeps a fixed set of git worktrees, the pool. They sit on the base branch
with dependencies and build output already in place. Take an idle one when a task starts, branch off there, and put
it back when the task is done, so the next task starts without reinstalling or rebuilding anything.

## Running the CLI

- If `wtpool` is on PATH (installed with `npm install -g github:OuYangMinOa/wtpool`), use it.
- Otherwise use the copy that ships with this skill: `node "<skill folder>/scripts/wtpool.mjs"`, where
  `<skill folder>` is the absolute path of the folder that holds this SKILL.md.

Below it is written as `wtpool`. It works from anywhere inside the repo, pool worktrees included. Exit codes:
`0` success, `1` error, `2` no idle worktree. Messages follow the system language; set `WTPOOL_LANG=en` or
`WTPOOL_LANG=zh-TW` to pick one.

## Starting a task

1. Run `wtpool which`. If you are already in a pool worktree on this task's branch, keep using it and don't take another.
2. Run `wtpool take <branch>`. It takes an idle worktree, creates the branch (or checks it out if it already exists)
   and prints only the worktree's path on stdout.
   - Name the branch the way the repo does (look at `git branch -a` or recent branch names, e.g. `feature/xxx`).
   - Do all reading, editing and running inside that path: `cd` into it at the start of each shell command and use
     absolute file paths.
   - The new branch starts from `base` in `.wtpool.json` and has no upstream; push it the first time with
     `git push -u origin <branch>`.
3. Exit code `2` means every worktree is busy. Show the user `wtpool status` and **ask before adding one**; only after
   they agree, run `wtpool add` and then `take` again. Never grow the pool on your own: each worktree is another full
   copy of the dependencies and build output.
4. Exit code `1` is an error. Act on the message (for example, an invalid branch name, or a branch already checked out
   in another worktree).

Use `wtpool take` rather than your own tool's way of creating worktrees, which makes a fresh, cold worktree outside
the pool. The exception is Claude Code with the wtpool plugin installed, below.

## Finishing a task

- After the branch is merged, run `wtpool release <wN>` (just `wtpool release` from inside that worktree). It switches
  the worktree back to the base branch and refreshes its dependencies. The branch itself is kept.
- `release` refuses while there are uncommitted changes. Commit them; only add `--stash` (the changes go to
  `git stash`) when they are definitely not needed.
- `wtpool sweep` puts back every worktree whose branch has been merged; `wtpool sweep --stale` also puts back worktrees
  that were taken long ago and have no new commits.

## Other commands

- `wtpool status`: what every worktree is doing (idle, in use, reclaimable, preparing…); `--json` for scripts.
- `wtpool refresh`: moves idle worktrees to the latest base branch and refreshes their dependencies.
- `wtpool remove <wN>`: deletes an idle worktree. Only when the user wants a smaller pool.

## Don't

- Don't delete a pool worktree's folder or run `git worktree remove` on it. When you are done with it, `release` it.
- Don't run `git clean -x` in a pool worktree or delete caches such as `node_modules` or `target`. Keeping them is the
  whole point of the pool.

## Claude Code with the wtpool plugin

The plugin's hooks serve Claude Code's own worktrees from the pool: `EnterWorktree`, `claude --worktree` and subagents
with `isolation: worktree` all get a pool worktree on a branch named `wt/<name>` (rename it with
`git branch -m <new name>`). When every worktree is busy, the hook creates an ordinary one in
`.claude/worktrees/<name>`; nothing to do there. Pool worktrees used by subagents are not put back automatically, so
run `wtpool sweep` once their branches are merged. With this skill alone, without the plugin, those features don't use
the pool; use `wtpool take`.

## Setting up a pool (only when the user asks)

`wtpool init` writes a `.wtpool.json` (guessing the base branch and the install commands) and creates the worktrees.
Show the user what it wrote, especially `base` and `setup`, and let them decide whether to commit it. Fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `base` | origin's default branch | New branches start here and released worktrees go back here, e.g. `origin/dev` |
| `dir` | `../{repo}-worktrees` | Where the worktrees live, relative to the repo root |
| `name` | `w{n}` | Folder name of each worktree |
| `size` | `2` | How many worktrees `init` creates |
| `setup` | `[]` | Preparation steps: `run` a command, in subfolder `cwd`, again only when files in `watch` changed or the path in `ifMissing` is gone |
| `copy` | `[]` | Files copied from the main checkout; they must be gitignored, such as `.env` |
| `hookBranch` | `wt/{name}` | Branch name used when Claude Code's own worktrees come from the pool |
| `staleAfterHours` | `24` | How long a taken worktree can go without commits before it counts as "maybe unused" |

To let other agents in the repo find the pool without this skill, suggest adding a short note to the repo's
`AGENTS.md` (or `CLAUDE.md`), for example: "This repo uses wtpool (`.wtpool.json`). Before working on a new branch,
run `wtpool take <branch>` and work in the printed path; when the branch is merged, run `wtpool release`."
