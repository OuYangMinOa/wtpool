// node --test test/
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../skills/wtpool/scripts/wtpool.mjs', import.meta.url))
// 既有的斷言用中文訊息，預設固定用 zh-TW 跑；英文另外測
const BASE_ENV = { WTPOOL_LANG: 'zh-TW' }

const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text)
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const warmCount = dir => {
  try {
    return read(dir, 'warm-count.txt').length
  } catch {
    return 0
  }
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`)
  return r.stdout.trim()
}
const gitOk = (cwd, ...args) => spawnSync('git', args, { cwd, windowsHide: true }).status === 0

function wt(cwd, args, { input, env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...BASE_ENV, ...env },
  })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

// 跟 Claude Code 一樣用 pipe 接 stdout/stderr，等到 pipe 關掉才算結束
function wtAsync(cwd, args, { input, env } = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...BASE_ENV, ...env },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('close', code => resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - started }))
    child.stdin.end(input ?? '')
  })
}

async function waitFor(fn, ms = 15_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fn()) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

const WARM_SCRIPT = `const fs = require('fs')
const ms = Number(process.env.WARM_SLEEP || 0)
if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
fs.appendFileSync('warm-count.txt', 'x')
fs.writeFileSync('warmed.txt', 'ok')
if (process.env.WARM_FAIL) process.exit(1)
`

// Windows 上背景的 wtpool 還沒結束時目錄刪不掉，等它一下
function tempDir(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wtpool-')))
  t.after(async () => {
    const until = Date.now() + 20_000
    for (;;) {
      try {
        fs.rmSync(root, { recursive: true, force: true })
        return
      } catch (e) {
        if (Date.now() > until) throw e
        await new Promise(r => setTimeout(r, 200))
      }
    }
  })
  return root
}

// 本機的 bare repo 當 origin，dev 是基準分支
function sandbox(t, config = {}) {
  const root = tempDir(t)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
  git(root, 'clone', '--quiet', origin, repo)
  git(repo, 'config', 'user.name', 'wtpool test')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, '.gitignore', 'warmed.txt\nwarm-count.txt\n.env\n')
  write(repo, 'deps.lock', 'v1\n')
  write(repo, 'warm.cjs', WARM_SCRIPT)
  const cfg = {
    base: 'origin/dev',
    dir: '../pool',
    name: 'slot{n}',
    size: 2,
    copy: ['.env'],
    setup: [{ run: 'node warm.cjs', watch: ['deps.lock'], ifMissing: 'warmed.txt' }],
    ...config,
  }
  write(repo, '.wtpool.json', JSON.stringify(cfg, null, 2))
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'init')
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:dev')
  git(repo, 'fetch', '--quiet', 'origin')
  write(repo, '.env', 'SECRET=1\n')
  return { root, repo, pool: path.join(root, 'pool'), slot: n => path.join(root, 'pool', `slot${n}`) }
}

// 在 origin/dev 上做點事再推上去（模擬別人合併了東西）
function onDev(s, fn) {
  const tmp = path.join(s.root, `tmp-${Date.now()}`)
  git(s.repo, 'worktree', 'add', '--quiet', '--detach', tmp, 'origin/dev')
  fn(tmp)
  git(tmp, 'push', '--quiet', 'origin', 'HEAD:dev')
  git(s.repo, 'worktree', 'remove', '--force', tmp)
  git(s.repo, 'fetch', '--quiet', 'origin')
}
const pushToDev = (s, file, text) =>
  onDev(s, tmp => {
    write(tmp, file, text)
    git(tmp, 'add', file)
    git(tmp, 'commit', '--quiet', '-m', `change ${file}`)
  })
const commitFile = (cwd, file, text) => {
  write(cwd, file, text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '--quiet', '-m', `${file}: ${text.trim()}`)
}

const states = s => JSON.parse(wt(s.repo, ['status', '--json', '--no-fetch']).out).slots.map(x => x.state)

test('init：建立 worktree、裝套件、複製 .env', t => {
  const s = sandbox(t)
  const r = wt(s.repo, ['init'])
  assert.equal(r.code, 0, r.err)
  for (const n of [1, 2]) {
    assert.equal(warmCount(s.slot(n)), 1)
    assert.equal(read(s.slot(n), '.env'), 'SECRET=1\n')
    assert.equal(git(s.slot(n), 'status', '--porcelain'), '')
  }
  assert.deepEqual(states(s), ['idle', 'idle'])
})

test('take：從基準分支開新分支，不設 upstream，也不重裝', t => {
  const s = sandbox(t)
  wt(s.repo, ['init'])
  const r = wt(s.repo, ['take', 'feature/a'])
  assert.equal(r.code, 0, r.err)
  assert.ok(same(r.out, s.slot(1)), r.out)
  assert.equal(git(r.out, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/a')
  assert.equal(git(r.out, 'rev-parse', 'HEAD'), git(s.repo, 'rev-parse', 'origin/dev'))
  assert.equal(gitOk(s.repo, 'config', '--get', 'branch.feature/a.merge'), false)
  assert.equal(warmCount(r.out), 1)
  assert.match(git(s.repo, 'worktree', 'list', '--porcelain'), /locked wtpool: feature\/a/)
  assert.deepEqual(states(s), ['busy', 'idle'])

  const again = wt(s.repo, ['take', 'feature/a'])
  assert.equal(again.code, 0, again.err)
  assert.equal(again.out, r.out)

  const which = wt(r.out, ['which'])
  assert.equal(which.code, 0)
  assert.match(which.out, /^w1\t使用中\tfeature\/a\t/)
})

test('take：都在忙就回結束碼 2', t => {
  const s = sandbox(t)
  wt(s.repo, ['init'])
  assert.equal(wt(s.repo, ['take', 'a']).code, 0)
  assert.equal(wt(s.repo, ['take', 'b']).code, 0)
  const r = wt(s.repo, ['take', 'c'])
  assert.equal(r.code, 2)
  assert.match(r.err, /wtpool add/)
})

test('take：同時拿不會拿到同一個', async t => {
  const s = sandbox(t, { size: 3 })
  wt(s.repo, ['init'])
  const runs = await Promise.all(['x1', 'x2', 'x3', 'x4'].map(b => wtAsync(s.repo, ['take', b, '--no-fetch'])))
  const ok = runs.filter(r => r.code === 0)
  assert.equal(ok.length, 3, runs.map(r => r.err).join('\n'))
  assert.equal(new Set(ok.map(r => r.out.toLowerCase())).size, 3)
  assert.equal(runs.filter(r => r.code === 2).length, 1)
})

test('release：有未提交的變更就拒絕，--stash 收起來；分支留著', t => {
  const s = sandbox(t)
  wt(s.repo, ['init'])
  const p = wt(s.repo, ['take', 'feature/a']).out
  write(p, 'draft.txt', 'wip')
  const refused = wt(p, ['release'])
  assert.equal(refused.code, 1)
  assert.match(refused.err, /未提交/)

  write(p, '.gitignore', `${read(p, '.gitignore')}# 改了追蹤中的檔案\n`)
  const r = wt(p, ['release', '--stash'])
  assert.equal(r.code, 0, r.err)
  assert.equal(git(s.repo, 'stash', 'list'), '', '不進所有 worktree 共用的 git stash')
  const ref = git(s.repo, 'for-each-ref', '--format=%(refname)', 'refs/wtpool/stash/')
  assert.match(ref, /^refs\/wtpool\/stash\/w1-\d+T\d+Z$/)
  assert.ok(r.err.includes(`git stash apply ${ref}`), r.err)
  assert.equal(gitOk(p, 'symbolic-ref', '-q', 'HEAD'), false) // detached
  assert.ok(gitOk(s.repo, 'rev-parse', '--verify', 'refs/heads/feature/a'))
  assert.doesNotMatch(git(s.repo, 'worktree', 'list', '--porcelain'), /locked/)
  assert.deepEqual(states(s), ['idle', 'idle'])

  // 拿得回來，沒追蹤的檔案也在
  git(p, 'switch', '--quiet', 'feature/a')
  git(p, 'stash', 'apply', '--quiet', ref)
  assert.equal(read(p, 'draft.txt'), 'wip')
  assert.match(read(p, '.gitignore'), /改了追蹤中的檔案/)
})

test('release：分支上改了 lockfile（commit 了或收起來），沒合併就放回也要重裝', async t => {
  const s = sandbox(t, { size: 1 })
  wt(s.repo, ['init'])
  const a = wt(s.repo, ['take', 'feature/bump']).out
  commitFile(a, 'deps.lock', 'v2\n')
  assert.equal(wt(a, ['release']).code, 0)
  assert.equal(warmCount(s.slot(1)), 2, '分支上的 lockfile 跟基準不同，要照基準重裝')
  assert.equal(wt(s.repo, ['refresh']).code, 0)
  assert.equal(warmCount(s.slot(1)), 2, '裝過了就不再裝')

  const b = wt(s.repo, ['take', 'feature/dirty']).out
  write(b, 'deps.lock', 'v3\n')
  assert.equal(wt(b, ['release', '--stash']).code, 0)
  assert.equal(warmCount(s.slot(1)), 3, '沒 commit 的 lockfile 變更也算')

  // hook 放回是在背景裝
  const c = wt(s.repo, ['hook', 'create'], { input: JSON.stringify({ name: 'bump', cwd: s.repo }) }).out
  commitFile(c, 'deps.lock', 'v4\n')
  assert.equal(wt(s.repo, ['hook', 'remove'], { input: JSON.stringify({ worktree_path: c }) }).code, 0)
  assert.ok(await waitFor(() => warmCount(s.slot(1)) === 4), '背景也要重裝')
})

test('take：裝套件失敗以後再 take 一次會重裝，不會直接給沒裝好的', t => {
  const s = sandbox(t, { size: 1 })
  wt(s.repo, ['init'])
  pushToDev(s, 'deps.lock', 'v2\n')
  const failed = wt(s.repo, ['take', 'feature/a'], { env: { WARM_FAIL: '1' } })
  assert.equal(failed.code, 1)
  const st = JSON.parse(wt(s.repo, ['status', '--json', '--no-fetch']).out).slots[0]
  assert.equal(st.state, 'busy')
  assert.match(st.note, /準備失敗.*wtpool take feature\/a/)

  const again = wt(s.repo, ['take', 'feature/a'])
  assert.equal(again.code, 0, again.err)
  assert.equal(warmCount(s.slot(1)), 3, '重跑一次')
  assert.equal(wt(s.repo, ['take', 'feature/a']).code, 0)
  assert.equal(warmCount(s.slot(1)), 3, '裝好了就不再裝')
})

test('setup：只有 watch 的檔案變了才重跑', t => {
  const s = sandbox(t)
  wt(s.repo, ['init'])
  pushToDev(s, 'README.md', 'hello\n')
  const a = wt(s.repo, ['take', 'feature/a'])
  assert.equal(a.code, 0, a.err)
  assert.equal(warmCount(a.out), 1, '只改 README，不用重裝')

  pushToDev(s, 'deps.lock', 'v2\n')
  const b = wt(s.repo, ['take', 'feature/b'])
  assert.equal(b.code, 0, b.err)
  assert.ok(same(b.out, s.slot(2)))
  assert.equal(warmCount(b.out), 2, 'deps.lock 變了要重裝')

  wt(a.out, ['release'])
  assert.equal(warmCount(s.slot(1)), 2, '放回時切到新的基準，也要重裝')
  assert.equal(wt(s.repo, ['refresh']).code, 0)
  assert.equal(warmCount(s.slot(1)), 2, '沒有變就不重跑')
})

test('setup 失敗：記下來，下次全部重跑', t => {
  const s = sandbox(t, { size: 1 })
  const r = wt(s.repo, ['init'], { env: { WARM_FAIL: '1' } })
  assert.equal(r.code, 1)
  assert.match(r.err, /準備失敗/)
  const st = JSON.parse(wt(s.repo, ['status', '--json', '--no-fetch']).out).slots[0]
  assert.equal(st.state, 'idle')
  assert.equal(st.warm.ok, false)
  assert.equal(wt(s.repo, ['refresh']).code, 0)
  assert.equal(warmCount(s.slot(1)), 2)
})

test('sweep：分支合併進基準以後放回', t => {
  const s = sandbox(t)
  wt(s.repo, ['init'])
  const p = wt(s.repo, ['take', 'feature/done']).out
  write(p, 'feature.txt', 'done\n')
  git(p, 'add', '.')
  git(p, 'commit', '--quiet', '-m', 'feature')
  assert.deepEqual(states(s), ['busy', 'idle'])
  git(p, 'push', '--quiet', 'origin', 'HEAD:dev')
  git(s.repo, 'fetch', '--quiet', 'origin')
  assert.deepEqual(states(s), ['done', 'idle'])

  const r = wt(s.repo, ['sweep'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(states(s), ['idle', 'idle'])
  assert.ok(gitOk(s.repo, 'rev-parse', '--verify', 'refs/heads/feature/done'), '自己取名的分支不刪')
})

test('sweep：squash 合併、rebase 合併也認得', t => {
  const s = sandbox(t)
  wt(s.repo, ['init'])
  const sq = wt(s.repo, ['take', 'feature/sq']).out
  commitFile(sq, 'a.txt', '1\n')
  commitFile(sq, 'a.txt', '2\n')
  git(sq, 'push', '--quiet', '-u', 'origin', 'HEAD')
  const rb = wt(s.repo, ['take', 'feature/rb']).out
  commitFile(rb, 'b.txt', '1\n')
  commitFile(rb, 'b.txt', '2\n')
  assert.deepEqual(states(s), ['busy', 'busy'])

  pushToDev(s, 'other.txt', 'someone else\n') // 基準先往前走，合併出來的 commit 才不會剛好是同一個
  onDev(s, tmp => {
    git(tmp, 'merge', '--quiet', '--squash', 'feature/sq')
    git(tmp, 'commit', '--quiet', '-m', 'Squash feature/sq (#1)')
    git(tmp, 'cherry-pick', 'origin/dev..feature/rb')
  })
  git(s.repo, 'push', '--quiet', 'origin', ':feature/sq') // GitHub 合併完刪掉分支
  assert.deepEqual(states(s), ['done', 'done'])

  const r = wt(s.repo, ['sweep'])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.err, /commit/, '已經合併了，不要說還有 commit 沒進去')
  assert.deepEqual(states(s), ['idle', 'idle'])
})

test('status：遠端分支被刪了只提示，不當成可回收', t => {
  const s = sandbox(t, { size: 1 })
  wt(s.repo, ['init'])
  const p = wt(s.repo, ['take', 'feature/closed']).out
  commitFile(p, 'c.txt', 'wip\n')
  git(p, 'push', '--quiet', '-u', 'origin', 'HEAD')
  git(s.repo, 'push', '--quiet', 'origin', ':feature/closed') // PR 沒合併就關掉、分支刪了
  git(s.repo, 'fetch', '--quiet', '--prune', 'origin')
  const st = JSON.parse(wt(s.repo, ['status', '--json', '--no-fetch']).out).slots[0]
  assert.equal(st.state, 'busy')
  assert.match(st.note, /遠端的分支已經刪掉/)
})

test('hook remove：squash 合併過的 wt/* 分支會刪掉', t => {
  const s = sandbox(t, { size: 1 })
  wt(s.repo, ['init'])
  const p = wt(s.repo, ['hook', 'create'], { input: JSON.stringify({ name: 'sq', cwd: s.repo }) }).out
  commitFile(p, 'a.txt', '1\n')
  commitFile(p, 'a.txt', '2\n')
  pushToDev(s, 'other.txt', 'x\n')
  onDev(s, tmp => {
    git(tmp, 'merge', '--quiet', '--squash', 'wt/sq')
    git(tmp, 'commit', '--quiet', '-m', 'squash')
  })
  const r = wt(s.repo, ['hook', 'remove'], { input: JSON.stringify({ worktree_path: p }) })
  assert.equal(r.code, 0, r.err)
  assert.equal(gitOk(s.repo, 'rev-parse', '--verify', 'refs/heads/wt/sq'), false)
})

test('--no-fetch：每個指令都不 fetch；status 預設只抓基準分支', t => {
  const s = sandbox(t, { size: 1 })
  wt(s.repo, ['init'])
  git(s.repo, 'remote', 'set-url', 'origin', path.join(s.root, 'nowhere.git'))
  for (const args of [['status'], ['add'], ['sweep'], ['refresh'], ['init', '3']]) {
    const r = wt(s.repo, [...args, '--no-fetch'])
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`)
    assert.doesNotMatch(r.err, /fetch/, args.join(' '))
  }
  assert.match(wt(s.repo, ['status']).err, /git fetch origin 失敗/, '沒加 --no-fetch 會試著抓')
})

test('init：認得 Yarn 2 以上和 PnP', t => {
  const root = tempDir(t)
  const cases = [
    { files: {}, run: 'yarn install --frozen-lockfile', ifMissing: 'node_modules' },
    { files: { '.yarnrc.yml': 'enableGlobalCache: true\n' }, run: 'yarn install --immutable', ifMissing: '.pnp.cjs' },
    { files: { '.yarnrc.yml': 'nodeLinker: node-modules\n' }, run: 'yarn install --immutable', ifMissing: 'node_modules' },
    { files: { 'package.json': '{"packageManager":"yarn@4.5.0"}' }, run: 'yarn install --immutable', ifMissing: '.pnp.cjs' },
  ]
  cases.forEach((c, i) => {
    const repo = path.join(root, `y${i}`)
    fs.mkdirSync(repo)
    git(repo, 'init', '--quiet')
    write(repo, 'yarn.lock', '')
    for (const [f, text] of Object.entries(c.files)) write(repo, f, text)
    const r = wt(repo, ['init', '0', '--no-fetch'])
    assert.equal(r.code, 0, r.err)
    const [step] = JSON.parse(read(repo, '.wtpool.json')).setup
    assert.deepEqual([step.run, step.ifMissing], [c.run, c.ifMissing], JSON.stringify(c.files))
  })
})

test('hook：沒有 .wtpool.json 的 repo 照 Claude Code 的做法開', t => {
  const root = tempDir(t)
  const repo = path.join(root, 'plain')
  fs.mkdirSync(repo)
  git(repo, 'init', '--quiet')
  git(repo, 'config', 'user.name', 'wtpool test')
  git(repo, 'config', 'user.email', 'test@example.com')
  write(repo, '.gitignore', '.env*\n.claude/\n')
  write(repo, '.worktreeinclude', '# 註解\n.env*\nmissing.txt\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'init')
  write(repo, '.env', 'A=1\n')
  write(repo, '.env.local', 'B=2\n')

  const input = JSON.stringify({ name: 'quick-fox', cwd: repo })
  const r = wt(repo, ['hook', 'create'], { input })
  assert.equal(r.code, 0, r.err)
  assert.ok(same(r.out, path.join(repo, '.claude', 'worktrees', 'quick-fox')), r.out)
  assert.equal(git(r.out, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worktree-quick-fox')
  assert.equal(read(r.out, '.env'), 'A=1\n')
  assert.equal(read(r.out, '.env.local'), 'B=2\n')
  assert.equal(wt(repo, ['hook', 'create'], { input }).out, r.out, '同一個名字沿用')

  const removed = wt(repo, ['hook', 'remove'], { input: JSON.stringify({ worktree_path: r.out }) })
  assert.equal(removed.code, 0, removed.err)
  assert.equal(fs.existsSync(r.out), false)
  assert.equal(gitOk(repo, 'rev-parse', '--verify', 'refs/heads/worktree-quick-fox'), false)

  const notGit = wt(os.tmpdir(), ['hook', 'create'], { input: JSON.stringify({ name: 'x', cwd: os.tmpdir() }) })
  assert.equal(notGit.code, 1)
})

test('hook：create 拿 worktree、remove 放回並刪掉沒用到的分支', t => {
  const s = sandbox(t)
  wt(s.repo, ['init'])
  const input = JSON.stringify({ name: 'bold-oak', cwd: s.repo, session_id: 'abc' })
  const r = wt(s.repo, ['hook', 'create'], { input })
  assert.equal(r.code, 0, r.err)
  assert.ok(same(r.out, s.slot(1)))
  assert.equal(git(r.out, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wt/bold-oak')
  assert.equal(wt(s.repo, ['hook', 'create'], { input }).out, r.out, '同一個名字拿回同一個')

  write(r.out, 'scratch.txt', 'tmp')
  const removed = wt(s.repo, ['hook', 'remove'], { input: JSON.stringify({ worktree_path: r.out }) })
  assert.equal(removed.code, 0, removed.err)
  assert.match(removed.out, /已放回/)
  assert.match(removed.out, /git stash/)
  assert.equal(gitOk(s.repo, 'rev-parse', '--verify', 'refs/heads/wt/bold-oak'), false)
  assert.ok(fs.existsSync(r.out), '池子的 worktree 不刪')

  const notOurs = wt(s.repo, ['hook', 'remove'], { input: JSON.stringify({ worktree_path: s.repo }) })
  assert.equal(notOurs.code, 1, '不認得的 worktree 不動')
  assert.ok(fs.existsSync(s.repo))
})

test('hook：有 commit 的分支放回時留著', t => {
  const s = sandbox(t)
  wt(s.repo, ['init'])
  const p = wt(s.repo, ['hook', 'create'], { input: JSON.stringify({ name: 'agent-1', cwd: s.repo }) }).out
  write(p, 'work.txt', 'work\n')
  git(p, 'add', '.')
  git(p, 'commit', '--quiet', '-m', 'work')
  const r = wt(s.repo, ['hook', 'remove'], { input: JSON.stringify({ worktree_path: p }) })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /1 個 commit/)
  assert.ok(gitOk(s.repo, 'rev-parse', '--verify', 'refs/heads/wt/agent-1'))
})

test('hook：池子都在忙時照 Claude Code 的做法另開一個', t => {
  const s = sandbox(t, { size: 1 })
  wt(s.repo, ['init'])
  wt(s.repo, ['take', 'feature/a'])
  const r = wt(s.repo, ['hook', 'create'], { input: JSON.stringify({ name: 'n1', cwd: s.repo }) })
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /沒有閒著的/)
  assert.ok(same(r.out, path.join(s.repo, '.claude', 'worktrees', 'n1')), r.out)
  assert.equal(git(r.out, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wt/n1')
  assert.equal(git(r.out, 'rev-parse', 'HEAD'), git(s.repo, 'rev-parse', 'origin/dev'), '從設定的 base 開')
  assert.deepEqual(states(s), ['busy'], '池子不會自己變大')

  // 模擬剛離開這個目錄的 session 還開著它（Windows 上目錄會刪不掉）
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { cwd: r.out, windowsHide: true })
  const removed = wt(s.repo, ['hook', 'remove'], { input: JSON.stringify({ worktree_path: r.out }) })
  holder.kill()
  assert.equal(removed.code, 0, removed.err)
  assert.doesNotMatch(git(s.repo, 'worktree', 'list'), /n1/)
  assert.equal(gitOk(s.repo, 'rev-parse', '--verify', 'refs/heads/wt/n1'), false)

  const again = wt(s.repo, ['hook', 'create'], { input: JSON.stringify({ name: 'n1', cwd: s.repo }) })
  assert.equal(again.code, 0, '同名再開可以用留下來的空目錄')
})

test('hook：閒著的還要裝套件就先裝好再給', t => {
  const s = sandbox(t, { size: 1 })
  wt(s.repo, ['init'])
  pushToDev(s, 'deps.lock', 'v2\n')
  const r = wt(s.repo, ['hook', 'create'], { input: JSON.stringify({ name: 'n2', cwd: s.repo }) })
  assert.equal(r.code, 0, r.err)
  assert.ok(same(r.out, s.slot(1)))
  assert.equal(warmCount(r.out), 2)
})

test('hook remove：背景準備很久也不會卡住', async t => {
  const s = sandbox(t, { size: 1 })
  wt(s.repo, ['init'])
  const p = wt(s.repo, ['hook', 'create'], { input: JSON.stringify({ name: 'slow', cwd: s.repo }) }).out
  pushToDev(s, 'deps.lock', 'v2\n')
  const r = await wtAsync(s.repo, ['hook', 'remove'], {
    input: JSON.stringify({ worktree_path: p }),
    env: { WARM_SLEEP: '4000' },
  })
  assert.equal(r.code, 0, r.err)
  assert.ok(r.ms < 3500, `花了 ${r.ms} ms`)
  assert.ok(await waitFor(() => warmCount(p) === 2), '背景要把套件裝好')
})

test('設定檔打錯字會說清楚', t => {
  const s = sandbox(t, { sise: 3 })
  const r = wt(s.repo, ['status', '--no-fetch'])
  assert.equal(r.code, 1)
  assert.match(r.err, /不認得的欄位 sise/)
})

test('remove：只能移除閒置的', t => {
  const s = sandbox(t)
  wt(s.repo, ['init'])
  wt(s.repo, ['take', 'feature/a'])
  assert.equal(wt(s.repo, ['remove', 'w1']).code, 1)
  const r = wt(s.repo, ['remove', 'w2'])
  assert.equal(r.code, 0, r.err)
  assert.equal(fs.existsSync(s.slot(2)), false)
  assert.deepEqual(states(s), ['busy'])
})

test('WTPOOL_LANG=en：訊息、狀態、說明都是英文', t => {
  const s = sandbox(t, { size: 1 })
  const en = { env: { WTPOOL_LANG: 'en' } }
  wt(s.repo, ['init'], en)
  assert.match(wt(s.repo, ['status', '--no-fetch'], en).out, /^w1\s+idle\s/m)
  assert.equal(JSON.parse(wt(s.repo, ['status', '--json', '--no-fetch'], en).out).slots[0].label, 'idle')
  const a = wt(s.repo, ['take', 'feature/a'], en)
  assert.equal(a.code, 0, a.err)
  assert.match(a.err, /w1: feature\/a \(new branch from origin\/dev\)/)
  const busy = wt(s.repo, ['take', 'feature/b'], en)
  assert.equal(busy.code, 2)
  assert.match(busy.err, /No idle worktree/)
  assert.match(busy.out, /in use/)
  write(a.out, 'draft.txt', 'wip')
  assert.match(wt(a.out, ['release'], en).err, /^error: w1 has uncommitted changes/)
  assert.match(wt(s.repo, ['help'], en).out, /Usage: wtpool <command>/)
  assert.match(wt(s.repo, ['nope'], en).err, /unknown command: nope/)
  assert.doesNotMatch(wt(s.repo, ['help'], en).out, /[一-鿿]/, '英文說明裡不該有中文')
})

test('WTPOOL_LANG：zh、zh_TW、大小寫都認得；沒設就看系統語言', t => {
  const s = sandbox(t)
  for (const v of ['zh', 'zh_TW', 'ZH-tw']) {
    assert.match(wt(s.repo, ['help'], { env: { WTPOOL_LANG: v } }).out, /用法：wtpool/, v)
  }
  for (const v of ['en', 'EN_us']) {
    assert.match(wt(s.repo, ['help'], { env: { WTPOOL_LANG: v } }).out, /Usage: wtpool/, v)
  }
  if (process.platform !== 'win32') {
    const auto = env => wt(s.repo, ['help'], { env: { WTPOOL_LANG: '', LC_ALL: '', LC_MESSAGES: '', ...env } }).out
    assert.match(auto({ LANG: 'zh_TW.UTF-8' }), /用法：wtpool/)
    assert.match(auto({ LANG: 'en_US.UTF-8' }), /Usage: wtpool/)
  }
})

test('設定檔錯誤用英文也說清楚', t => {
  const s = sandbox(t, { sise: 3 })
  const r = wt(s.repo, ['status', '--no-fetch'], { env: { WTPOOL_LANG: 'en' } })
  assert.equal(r.code, 1)
  assert.match(r.err, /unknown field\(s\) sise/)
})
