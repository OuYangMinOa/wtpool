// node --test test/
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../cli/wtpool.mjs', import.meta.url))
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

// 在 origin/dev 上多一個 commit（模擬別人合併了東西）
function pushToDev(s, file, text) {
  const tmp = path.join(s.root, `tmp-${Date.now()}`)
  git(s.repo, 'worktree', 'add', '--quiet', '--detach', tmp, 'origin/dev')
  write(tmp, file, text)
  git(tmp, 'add', file)
  git(tmp, 'commit', '--quiet', '-m', `change ${file}`)
  git(tmp, 'push', '--quiet', 'origin', 'HEAD:dev')
  git(s.repo, 'worktree', 'remove', '--force', tmp)
  git(s.repo, 'fetch', '--quiet', 'origin')
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

  const r = wt(p, ['release', '--stash'])
  assert.equal(r.code, 0, r.err)
  assert.match(git(s.repo, 'stash', 'list'), /wtpool: feature\/a/)
  assert.equal(gitOk(p, 'symbolic-ref', '-q', 'HEAD'), false) // detached
  assert.ok(gitOk(s.repo, 'rev-parse', '--verify', 'refs/heads/feature/a'))
  assert.doesNotMatch(git(s.repo, 'worktree', 'list', '--porcelain'), /locked/)
  assert.deepEqual(states(s), ['idle', 'idle'])
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
