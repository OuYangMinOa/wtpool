#!/usr/bin/env node
// wtpool：預熱好的 git worktree 池。
//
// 池子裡的 worktree 平常停在基準分支（detached HEAD），node_modules、編譯產物都留著。
// 接到需求時挑一個閒著的開分支，做完放回去，下一個需求就不用重裝、重編。
// 設定寫在 repo 根目錄的 .wtpool.json，說明見 README.md。
//
// 只用 Node 內建模組，Node 18 以上就能跑。

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.1.0'
const SELF = fileURLToPath(import.meta.url)
const CONFIG_FILE = '.wtpool.json'
const META_FILE = 'wtpool.json'
const LOCK_FILE = 'wtpool.lock'
const LOG_FILE = 'wtpool.log'
const IS_WIN = process.platform === 'win32'

const EXIT = { OK: 0, ERROR: 1, BUSY: 2 }

const DEFAULTS = Object.freeze({
  base: null,
  dir: '../{repo}-worktrees',
  name: 'w{n}',
  size: 2,
  hookBranch: 'wt/{name}',
  copy: [],
  setup: [],
  staleAfterHours: 24,
})
const STEP_KEYS = ['run', 'cwd', 'watch', 'ifMissing']

const STATE_LABEL = {
  idle: '閒置',
  done: '可回收',
  stale: '可能沒在用',
  busy: '使用中',
  warming: '準備中',
  missing: '不見了',
}

const HELP = `wtpool ${VERSION}：預熱好的 git worktree 池

用法：wtpool <指令> [參數]

  init [數量]            沒有 ${CONFIG_FILE} 就產生一份，再把 worktree 補到指定數量
  status [--json]        列出每個 worktree 的狀態
  take <分支> [--slot wN] [--from <ref>]
                         挑一個閒著的 worktree 開分支（分支已存在就切過去），只把路徑印到 stdout
  release [wN|分支|路徑] [--stash]
                         放回池子：切回基準分支並裝好套件，分支本身留著
  add [數量]             多開幾個 worktree
  remove <wN>            移除一個閒置的 worktree（整個目錄刪掉）
  refresh                把閒置的 worktree 更新到最新的基準分支並裝好套件
  sweep [--stale]        把分支已經合併的 worktree 放回去；--stale 連很久沒 commit 的也放
  which                  目前目錄在哪個 worktree
  hook create|remove     給 Claude Code 的 WorktreeCreate / WorktreeRemove hook 用，從 stdin 讀 JSON

共用參數：--no-fetch 不先 git fetch，--quiet 不印過程
結束碼：0 成功，1 錯誤，2 沒有閒著的 worktree`

class WtError extends Error {
  constructor(message, code = EXIT.ERROR) {
    super(message)
    this.code = code
  }
}

let quiet = false
const log = msg => {
  if (!quiet) process.stderr.write(`${msg}\n`)
}
const out = msg => process.stdout.write(`${msg}\n`)
const now = () => new Date().toISOString()
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// ---------- 路徑、程序 ----------

const norm = p => {
  const r = path.resolve(p).replace(/[\\/]+$/, '')
  return IS_WIN ? r.toLowerCase() : r
}
const samePath = (a, b) => norm(a) === norm(b)
const isInside = (child, parent) => {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + path.sep)
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function git(args, { cwd, timeout, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 256 << 20 })
  const res = {
    ok: !r.error && r.status === 0,
    out: (r.stdout ?? '').replace(/\s+$/, ''),
    err: (r.stderr ?? '').trim() || (r.error ? r.error.message : ''),
    timedOut: r.error?.code === 'ETIMEDOUT',
  }
  if (!res.ok && !allowFail) {
    throw new WtError(`git ${args.join(' ')} 失敗：${res.err || `結束碼 ${r.status}`}`)
  }
  return res
}
const gitOk = (args, cwd) => git(args, { cwd, allowFail: true }).ok
const revParse = (ref, cwd) => {
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFail: true })
  return r.ok ? r.out : null
}

// ---------- 設定與 repo ----------

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function loadConfig(file) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    throw new WtError(`${CONFIG_FILE} 讀不懂：${e.message}`)
  }
  const bad = msg => {
    throw new WtError(`${CONFIG_FILE}：${msg}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('內容要是一個 JSON 物件')
  const unknown = Object.keys(raw).filter(k => k !== '$schema' && !(k in DEFAULTS))
  if (unknown.length) bad(`有不認得的欄位 ${unknown.join(', ')}（可用的有 ${Object.keys(DEFAULTS).join(', ')}）`)

  const cfg = { ...DEFAULTS, ...raw }
  if (cfg.base !== null && (typeof cfg.base !== 'string' || !cfg.base)) bad('"base" 要是分支名稱，例如 "origin/main"')
  if (typeof cfg.dir !== 'string' || !cfg.dir) bad('"dir" 要是路徑')
  if (typeof cfg.name !== 'string' || cfg.name.split('{n}').length !== 2 || /[\\/]/.test(cfg.name)) {
    bad('"name" 要剛好含一個 {n}、不能有斜線，例如 "w{n}"')
  }
  if (!Number.isInteger(cfg.size) || cfg.size < 0) bad('"size" 要是 0 以上的整數')
  if (typeof cfg.hookBranch !== 'string' || cfg.hookBranch.split('{name}').length !== 2) {
    bad('"hookBranch" 要剛好含一個 {name}，例如 "wt/{name}"')
  }
  if (!Array.isArray(cfg.copy) || cfg.copy.some(c => typeof c !== 'string' || !c)) bad('"copy" 要是路徑的陣列')
  if (typeof cfg.staleAfterHours !== 'number' || !(cfg.staleAfterHours > 0)) bad('"staleAfterHours" 要是正數')
  if (!Array.isArray(cfg.setup)) bad('"setup" 要是陣列')
  cfg.setup = cfg.setup.map((step, i) => {
    const s = typeof step === 'string' ? { run: step } : step
    if (!s || typeof s !== 'object' || typeof s.run !== 'string' || !s.run) bad(`setup[${i}] 要有 "run"`)
    const extra = Object.keys(s).filter(k => !STEP_KEYS.includes(k))
    if (extra.length) bad(`setup[${i}] 有不認得的欄位 ${extra.join(', ')}（可用的有 ${STEP_KEYS.join(', ')}）`)
    const watch = s.watch === undefined ? [] : Array.isArray(s.watch) ? s.watch : [s.watch]
    if (watch.some(w => typeof w !== 'string' || !w)) bad(`setup[${i}].watch 要是路徑或路徑的陣列`)
    if (s.ifMissing !== undefined && (typeof s.ifMissing !== 'string' || !s.ifMissing)) bad(`setup[${i}].ifMissing 要是路徑`)
    if (s.cwd !== undefined && (typeof s.cwd !== 'string' || !s.cwd)) bad(`setup[${i}].cwd 要是路徑`)
    return { run: s.run, cwd: s.cwd, watch, ifMissing: s.ifMissing }
  })
  return cfg
}

function listWorktrees(cwd) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 << 20,
  })
  if (r.error || r.status !== 0) {
    throw new WtError(`git worktree list 失敗：${(r.stderr || r.error?.message || '').trim()}`)
  }
  const list = []
  let cur = null
  for (const field of r.stdout.split('\0')) {
    if (field === '') {
      if (cur) list.push(cur)
      cur = null
      continue
    }
    const i = field.indexOf(' ')
    const key = i < 0 ? field : field.slice(0, i)
    const val = i < 0 ? '' : field.slice(i + 1)
    if (key === 'worktree') cur = { path: path.resolve(val), head: null, branch: null, locked: null, bare: false }
    else if (!cur) continue
    else if (key === 'HEAD') cur.head = val
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '')
    else if (key === 'locked') cur.locked = val || '（沒寫原因）'
    else if (key === 'bare') cur.bare = true
  }
  if (cur) list.push(cur)
  return list
}

function detectBase(main) {
  const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: main, allowFail: true })
  if (head.ok && head.out) return head.out
  for (const ref of ['origin/main', 'origin/master']) if (revParse(ref, main)) return ref
  return null
}

function getContext(cwd) {
  if (!gitOk(['rev-parse', '--show-toplevel'], cwd)) throw new WtError(`${cwd} 不在 git repo 裡`)
  const common = path.resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }).out)
  const mainWt = listWorktrees(cwd)[0]
  if (!mainWt || mainWt.bare) throw new WtError('不支援 bare repo')
  const main = mainWt.path
  const cfgFile = path.join(main, CONFIG_FILE)
  const configured = fs.existsSync(cfgFile)
  const cfg = configured ? loadConfig(cfgFile) : { ...DEFAULTS }
  const repoName = path.basename(main)
  const base = cfg.base || detectBase(main)
  const remotes = git(['remote'], { cwd: main }).out.split(/\r?\n/).filter(Boolean)
  const m = base && /^([^/]+)\/(.+)$/.exec(base)
  const remote = m && remotes.includes(m[1]) ? m[1] : null
  const [slotA, slotB] = cfg.name.split('{n}')
  const [hookA, hookB] = cfg.hookBranch.split('{name}')
  return {
    cwd: path.resolve(cwd),
    main,
    common,
    cfg,
    cfgFile,
    configured,
    repoName,
    base,
    remote,
    baseBranch: remote ? m[2] : base,
    poolDir: path.resolve(main, cfg.dir.replaceAll('{repo}', repoName)),
    slotRe: new RegExp(`^${escapeRe(slotA)}(\\d+)${escapeRe(slotB)}$`, IS_WIN ? 'i' : ''),
    hookRe: new RegExp(`^${escapeRe(hookA)}(.+)${escapeRe(hookB)}$`),
  }
}

function requireConfig(ctx) {
  if (!ctx.configured) throw new WtError(`${ctx.main} 還沒有 ${CONFIG_FILE}，先跑 wtpool init`)
}

function requireBase(ctx) {
  if (!ctx.base) throw new WtError(`找不到基準分支，請在 ${CONFIG_FILE} 設定 "base"（例如 "origin/main"）`)
  return ctx.base
}

function fetchBase(ctx, { timeout = 120_000 } = {}) {
  if (!ctx.remote) return
  const r = git(['fetch', '--quiet', '--prune', ctx.remote], { cwd: ctx.main, timeout, allowFail: true })
  if (r.ok) return
  const why = r.timedOut ? `超過 ${timeout / 1000} 秒` : r.err
  log(`警告：git fetch ${ctx.remote} 失敗（${why}），先用本機現有的 ${ctx.base}`)
}

// ---------- 互斥鎖：挑 worktree、改狀態時一次只讓一個 wtpool 做 ----------

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

function withLock(ctx, fn, waitMs = 30_000) {
  const file = path.join(ctx.common, LOCK_FILE)
  const started = Date.now()
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: now() }), { flag: 'wx' })
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let holder = null
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {}
      // 讀不到內容可能是對方剛建立、還沒寫完；放了 5 秒以上才當成殘留
      const mtime = mtimeOf(file)
      const stale = holder
        ? !isAlive(holder.pid) || Date.now() - Date.parse(holder.at) > 10 * 60_000
        : mtime !== null && Date.now() - mtime > 5_000
      if (stale) {
        try {
          fs.unlinkSync(file)
        } catch {}
        continue
      }
      if (Date.now() - started > waitMs) {
        throw new WtError(`另一個 wtpool（pid ${holder?.pid ?? '?'}）正在處理這個 repo，稍後再試`)
      }
      sleep(100)
    }
  }
  try {
    return fn()
  } finally {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file)
    } catch {}
  }
}

// ---------- worktree（slot）與它的狀態 ----------

function findSlots(ctx) {
  return listWorktrees(ctx.main)
    .flatMap(w => {
      if (!samePath(path.dirname(w.path), ctx.poolDir)) return []
      const m = ctx.slotRe.exec(path.basename(w.path))
      if (!m) return []
      const n = Number(m[1])
      return [{ ...w, n, name: `w${n}` }]
    })
    .sort((a, b) => a.n - b.n)
}

// 每個 worktree 的狀態存在 git 給它的管理目錄（.git/worktrees/<id>/），worktree 刪掉就跟著消失
const metaPath = slot => path.join(slot.admin, META_FILE)
function readMeta(slot) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(slot), 'utf8'))
  } catch {
    return {}
  }
}
function writeMeta(slot, meta) {
  const file = metaPath(slot)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2))
  fs.renameSync(tmp, file)
  slot.meta = meta
}
function updateMeta(slot, fn) {
  const meta = readMeta(slot)
  fn(meta)
  writeMeta(slot, meta)
}
function clearWarmLease(slot) {
  updateMeta(slot, m => {
    if (m.lease?.kind === 'warm' && m.lease.pid === process.pid) m.lease = null
  })
}

function inspect(ctx, slot) {
  const set = (state, note) => Object.assign(slot, { state, note })
  if (!fs.existsSync(slot.path)) return set('missing', '目錄不見了（可以跑 git worktree prune 清掉）')
  slot.admin = path.resolve(git(['rev-parse', '--absolute-git-dir'], { cwd: slot.path }).out)
  slot.meta = readMeta(slot)
  slot.headRev = git(['rev-parse', 'HEAD'], { cwd: slot.path }).out
  slot.dirty = git(['status', '--porcelain'], { cwd: slot.path }).out !== ''
  const lease = slot.meta.lease

  if (lease?.kind === 'warm' && isAlive(lease.pid)) return set('warming', '準備中（正在更新或安裝套件）')
  if (slot.dirty) return set('busy', '使用中（有未提交的變更）')
  if (!slot.branch) {
    if (slot.locked && lease?.kind !== 'take') return set('busy', `被 git worktree lock 鎖住：${slot.locked}`)
    return set('idle', slot.meta.warm?.ok === false ? '閒置（上次準備失敗，下次會重跑）' : '閒置')
  }

  const merged = Boolean(ctx.base) && gitOk(['merge-base', '--is-ancestor', 'HEAD', ctx.base], slot.path)
  if (lease?.kind === 'take' && lease.branch === slot.branch) {
    if (merged && slot.headRev !== lease.startRev) return set('done', `分支已合併進 ${ctx.base}`)
    const hours = (Date.now() - Date.parse(lease.since)) / 36e5
    if (slot.headRev === lease.startRev && hours >= ctx.cfg.staleAfterHours) {
      return set('stale', `拿走 ${Math.floor(hours)} 小時都沒有 commit`)
    }
    return set('busy', '使用中')
  }
  // 沒有 wtpool 的租約（舊版腳本拿的、或手動切的分支）：推過而且全部合併才算做完
  const upstream = git(['config', '--get', `branch.${slot.branch}.merge`], { cwd: ctx.main, allowFail: true }).out
  if (merged && upstream && upstream !== `refs/heads/${ctx.baseBranch}`) return set('done', `分支已合併進 ${ctx.base}`)
  return set('busy', '使用中')
}

function pickSlot(slots, key) {
  const k = String(key)
  const m = /^w?(\d+)$/i.exec(k)
  const slot = slots.find(s => (m && s.n === Number(m[1])) || path.basename(s.path).toLowerCase() === k.toLowerCase())
  if (!slot) throw new WtError(`找不到 worktree ${key}`)
  return slot
}

function resolveSlot(ctx, slots, key) {
  if (!key) {
    const here = slots.find(s => isInside(ctx.cwd, s.path))
    if (!here) throw new WtError('目前目錄不在 wtpool 的 worktree 裡，請指定要哪一個（例如 w2）')
    return here
  }
  const byBranch = slots.find(s => s.branch === key)
  if (byBranch) return byBranch
  const byPath = fs.existsSync(key) && slots.find(s => samePath(s.path, key))
  if (byPath) return byPath
  return pickSlot(slots, key)
}

// ---------- 準備（安裝套件、複製檔案） ----------

// 這個 worktree 要從現在的狀態變成 targetRev，需要重跑哪些 setup 步驟
function warmSteps(ctx, slot, targetRev) {
  const steps = ctx.cfg.setup
  if (!steps.length) return []
  const warm = slot.meta?.warm
  if (warm?.ok === false) return steps // 新建的、或上次失敗：全部重跑
  const since = warm?.rev || slot.headRev
  return steps.filter(step => {
    if (step.ifMissing && !fs.existsSync(path.join(slot.path, step.ifMissing))) return true
    if (step.watch.length && since && targetRev && since !== targetRev) {
      return !gitOk(['diff', '--quiet', since, targetRev, '--', ...step.watch], slot.path)
    }
    return false
  })
}

function runWarm(ctx, slot, steps) {
  const rev = git(['rev-parse', 'HEAD'], { cwd: slot.path }).out
  for (const step of steps) {
    log(`  ${slot.name}：${step.run}${step.cwd ? `（在 ${step.cwd}）` : ''}`)
    const r = spawnSync(step.run, {
      cwd: path.join(slot.path, step.cwd ?? '.'),
      shell: true,
      stdio: ['ignore', 2, 2], // 指令的輸出一律走 stderr，stdout 只留給路徑
      windowsHide: true,
      env: { ...process.env, WTPOOL_SLOT: String(slot.n), WTPOOL_PATH: slot.path },
    })
    if (r.error || r.status !== 0) {
      updateMeta(slot, m => {
        m.warm = { ok: false, rev: m.warm?.rev ?? null, at: now() }
      })
      throw new WtError(`${slot.name} 準備失敗：${step.run}（${r.error?.message ?? `結束碼 ${r.status}`}）`)
    }
  }
  updateMeta(slot, m => {
    m.warm = { ok: true, rev, at: now() }
  })
}

// 把主 checkout 裡被 gitignore 的檔案（.env 之類）複製進 worktree；沒被忽略的不複製，不然 worktree 會變髒
function copyIgnored(main, dest, rel, label) {
  const src = path.join(main, rel)
  const dst = path.join(dest, rel)
  let st
  try {
    st = fs.statSync(src)
  } catch {
    return
  }
  if (!st.isFile()) {
    log(`警告：只能複製檔案，略過 ${rel}`)
    return
  }
  if (!gitOk(['check-ignore', '--quiet', rel], main)) {
    log(`警告：${rel} 沒有被 .gitignore 忽略，略過`)
    return
  }
  try {
    if (fs.readFileSync(dst).equals(fs.readFileSync(src))) return
  } catch {}
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  log(`  ${label}：複製 ${rel}`)
}

function copyFiles(ctx, slot) {
  for (const rel of ctx.cfg.copy) copyIgnored(ctx.main, slot.path, rel, slot.name)
}

function spawnBackground(ctx, args) {
  const logFile = path.join(ctx.common, LOG_FILE)
  try {
    if (fs.statSync(logFile).size > 1 << 20) fs.truncateSync(logFile, 0)
  } catch {}
  const fd = fs.openSync(logFile, 'a')
  try {
    fs.writeSync(fd, `\n[${now()}] wtpool ${args.join(' ')}\n`)
    spawn(process.execPath, [SELF, ...args], {
      cwd: ctx.main,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    }).unref()
  } finally {
    fs.closeSync(fd)
  }
}

// ---------- 拿、放、加、刷新 ----------

function resolveTarget(ctx, branch, from) {
  const local = revParse(`refs/heads/${branch}`, ctx.main)
  if (local) {
    if (from) throw new WtError(`分支 ${branch} 已經存在，不能再指定 --from`)
    return { args: [branch], rev: local, desc: '切到既有的分支' }
  }
  if (from) {
    const rev = revParse(from, ctx.main)
    if (!rev) throw new WtError(`找不到 ${from}`)
    return { args: ['--no-track', '-c', branch, from], rev, desc: `從 ${from} 開新分支` }
  }
  if (ctx.remote) {
    const rev = revParse(`refs/remotes/${ctx.remote}/${branch}`, ctx.main)
    if (rev) return { args: ['--track', '-c', branch, `${ctx.remote}/${branch}`], rev, desc: `從 ${ctx.remote}/${branch} 接著做` }
  }
  const rev = revParse(ctx.base, ctx.main)
  if (!rev) throw new WtError(`找不到 ${ctx.base}${ctx.remote ? '（先 git fetch 看看）' : ''}`)
  // --no-track：不要把基準分支設成 upstream，免得之後 git push 推到基準分支
  return { args: ['--no-track', '-c', branch, ctx.base], rev, desc: `從 ${ctx.base} 開新分支` }
}

// opts.hook：從 Claude Code 的 hook 呼叫，fetch 不要等太久
function take(ctx, branch, opts = {}) {
  requireConfig(ctx)
  requireBase(ctx)
  if (!gitOk(['check-ref-format', '--branch', branch], ctx.main)) throw new WtError(`分支名稱不合法：${branch}`)
  if (!opts.noFetch) fetchBase(ctx, { timeout: opts.hook ? 10_000 : 120_000 })

  const picked = withLock(ctx, () => {
    const slots = findSlots(ctx).map(s => inspect(ctx, s))
    const mine = slots.find(s => s.branch === branch)
    if (mine) return { slot: mine, again: true }
    const elsewhere = listWorktrees(ctx.main).find(w => w.branch === branch)
    if (elsewhere) throw new WtError(`${branch} 已經在 ${elsewhere.path} 用著了`)

    const target = resolveTarget(ctx, branch, opts.from)
    let usable = slots.filter(s => s.state === 'idle' || s.state === 'done')
    if (opts.slot) {
      const s = pickSlot(slots, opts.slot)
      if (!usable.includes(s)) throw new WtError(`${s.name} 現在不能用：${STATE_LABEL[s.state]}（${s.note}）`)
      usable = [s]
    }
    // 不用重裝套件的優先，再來是閒置的優先
    const ranked = usable
      .map(s => ({ slot: s, steps: warmSteps(ctx, s, target.rev) }))
      .sort(
        (a, b) =>
          a.steps.length - b.steps.length ||
          (a.slot.state === 'idle' ? 0 : 1) - (b.slot.state === 'idle' ? 0 : 1) ||
          a.slot.n - b.slot.n,
      )
    if (!ranked.length) return { busy: true, slots }
    const { slot, steps } = ranked[0]

    git(['switch', '--quiet', ...target.args], { cwd: slot.path })
    slot.branch = branch
    const startRev = git(['rev-parse', 'HEAD'], { cwd: slot.path }).out
    git(['worktree', 'lock', '--reason', `wtpool: ${branch}`, slot.path], { cwd: ctx.main, allowFail: true })
    updateMeta(slot, m => {
      m.lease = { kind: 'take', branch, startRev, since: now(), by: opts.by ?? 'cli' }
    })
    return { slot, steps, desc: target.desc }
  })
  if (picked.busy) return picked
  const { slot } = picked
  if (picked.again) {
    log(`${branch} 已經在 ${slot.name}，沿用`)
    return picked
  }
  copyFiles(ctx, slot)
  runWarm(ctx, slot, picked.steps)
  log(`${slot.name}：${picked.desc} ${branch}`)
  return picked
}

// opts.stash：有未提交的變更就先收進 git stash；opts.deleteBranch：true 或 'hook'（只刪 hook 開的分支）
// opts.background：套件改在背景準備（hook 用，避免超時）
function release(ctx, key, opts = {}) {
  requireConfig(ctx)
  requireBase(ctx)
  if (!opts.noFetch) fetchBase(ctx, { timeout: opts.hook ? 10_000 : 120_000 })

  const r = withLock(ctx, () => {
    const slots = findSlots(ctx).map(s => inspect(ctx, s))
    const slot = resolveSlot(ctx, slots, key)
    if (slot.state === 'missing') throw new WtError(`${slot.name} ${slot.note}`)
    if (slot.state === 'warming') throw new WtError(`${slot.name} 正在準備中，等一下再放回`)
    const notes = []
    if (slot.dirty) {
      if (!opts.stash) {
        throw new WtError(`${slot.name} 有未提交的變更，先 commit 或清掉再放回（確定不要了可以加 --stash 收進 git stash）`)
      }
      const label = `wtpool: ${slot.branch ?? slot.name} 放回前沒提交的變更`
      git(['stash', 'push', '--include-untracked', '--message', label], { cwd: slot.path })
      notes.push('沒提交的變更收進了 git stash（git stash list 看得到）')
    }
    const branch = slot.branch
    if (branch) {
      const ahead = Number(git(['rev-list', '--count', `${ctx.base}..HEAD`], { cwd: slot.path, allowFail: true }).out || 0)
      if (ahead > 0) notes.push(`分支 ${branch} 還有 ${ahead} 個 commit 沒進 ${ctx.base}，分支會留著`)
    }
    git(['switch', '--quiet', '--detach', ctx.base], { cwd: slot.path })
    git(['worktree', 'unlock', slot.path], { cwd: ctx.main, allowFail: true })
    const del = opts.deleteBranch === true || (opts.deleteBranch === 'hook' && ctx.hookRe.test(branch ?? ''))
    if (branch && del && gitOk(['branch', '-d', branch], slot.path)) notes.push(`已刪除合併過的分支 ${branch}`)
    updateMeta(slot, m => {
      m.lease = opts.background ? null : { kind: 'warm', pid: process.pid, since: now() }
    })
    return { slot, notes, branch }
  })

  const { slot } = r
  if (opts.background) {
    spawnBackground(ctx, ['refresh', '--no-fetch'])
  } else {
    try {
      copyFiles(ctx, slot)
      runWarm(ctx, slot, warmSteps(ctx, slot, git(['rev-parse', 'HEAD'], { cwd: slot.path }).out))
    } finally {
      clearWarmLease(slot)
    }
  }
  for (const note of r.notes) log(note)
  log(`${slot.name} 已放回（${ctx.base}，detached）`)
  return r
}

function add(ctx, count = 1) {
  requireConfig(ctx)
  requireBase(ctx)
  fetchBase(ctx)
  if (!revParse(ctx.base, ctx.main)) throw new WtError(`找不到 ${ctx.base}`)

  const created = withLock(ctx, () => {
    const used = new Set(findSlots(ctx).map(s => s.n))
    const made = []
    for (let n = 1; made.length < count; n++) {
      if (used.has(n)) continue
      const p = path.join(ctx.poolDir, ctx.cfg.name.replace('{n}', String(n)))
      if (fs.existsSync(p)) throw new WtError(`${p} 已經存在，但不是這個 repo 的 worktree，請先確認裡面的東西`)
      fs.mkdirSync(ctx.poolDir, { recursive: true })
      log(`建立 w${n}（${ctx.base}）→ ${p}`)
      git(['worktree', 'add', '--quiet', '--detach', p, ctx.base], { cwd: ctx.main })
      const slot = findSlots(ctx).find(s => s.n === n)
      slot.admin = path.resolve(git(['rev-parse', '--absolute-git-dir'], { cwd: p }).out)
      writeMeta(slot, {
        warm: { ok: false, rev: null, at: now() },
        lease: { kind: 'warm', pid: process.pid, since: now() },
      })
      made.push(slot)
    }
    return made
  })

  let failed = null
  for (const slot of created) {
    try {
      copyFiles(ctx, slot)
      runWarm(ctx, slot, ctx.cfg.setup)
    } catch (e) {
      failed ??= e
      log(e.message)
    } finally {
      clearWarmLease(slot)
    }
  }
  if (failed) throw failed
  return created
}

function refresh(ctx, opts = {}) {
  requireConfig(ctx)
  requireBase(ctx)
  if (!opts.noFetch) fetchBase(ctx)
  const baseRev = revParse(ctx.base, ctx.main)
  if (!baseRev) throw new WtError(`找不到 ${ctx.base}`)

  const targets = withLock(ctx, () => {
    const idle = findSlots(ctx)
      .map(s => inspect(ctx, s))
      .filter(s => s.state === 'idle')
    for (const s of idle) {
      updateMeta(s, m => {
        m.lease = { kind: 'warm', pid: process.pid, since: now() }
      })
    }
    return idle
  })

  let failed = 0
  for (const slot of targets) {
    try {
      if (slot.headRev !== baseRev) git(['switch', '--quiet', '--detach', ctx.base], { cwd: slot.path })
      copyFiles(ctx, slot)
      runWarm(ctx, slot, warmSteps(ctx, slot, baseRev))
      log(`${slot.name}：已更新到 ${ctx.base}`)
    } catch (e) {
      failed++
      log(`${slot.name}：${e.message}`)
    } finally {
      clearWarmLease(slot)
    }
  }
  if (!targets.length) log('沒有閒置的 worktree 要更新')
  return failed ? EXIT.ERROR : EXIT.OK
}

function sweep(ctx, opts = {}) {
  requireConfig(ctx)
  requireBase(ctx)
  fetchBase(ctx)
  const slots = findSlots(ctx).map(s => inspect(ctx, s))
  const wanted = slots.filter(s => s.state === 'done' || (opts.stale && s.state === 'stale'))
  if (!wanted.length) log('沒有可以放回的 worktree')
  let failed = 0
  for (const s of wanted) {
    try {
      release(ctx, s.path, { noFetch: true, deleteBranch: 'hook' })
    } catch (e) {
      failed++
      log(`${s.name}：${e.message}`)
    }
  }
  return failed ? EXIT.ERROR : EXIT.OK
}

function remove(ctx, key) {
  requireConfig(ctx)
  const slot = withLock(ctx, () => {
    const slots = findSlots(ctx).map(s => inspect(ctx, s))
    const s = pickSlot(slots, key)
    if (s.state === 'missing') {
      git(['worktree', 'prune'], { cwd: ctx.main })
      return s
    }
    if (s.state !== 'idle') throw new WtError(`${s.name} 現在是「${STATE_LABEL[s.state]}」，只能移除閒置的`)
    git(['worktree', 'unlock', s.path], { cwd: ctx.main, allowFail: true })
    log(`移除 ${s.name}：${s.path}`)
    git(['worktree', 'remove', s.path], { cwd: ctx.main })
    return s
  })
  log(`${slot.name} 已移除`)
}

// ---------- 範本 ----------

function detectSetup(main) {
  const dirs = ['.']
  try {
    for (const d of fs.readdirSync(main, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') dirs.push(d.name)
    }
  } catch {}
  const steps = []
  for (const d of dirs) {
    const has = f => fs.existsSync(path.join(main, d, f))
    const rel = f => (d === '.' ? f : `${d}/${f}`)
    const cwd = d === '.' ? {} : { cwd: d }
    const node = (lock, run) => steps.push({ run, ...cwd, watch: [rel(lock)], ifMissing: rel('node_modules') })
    if (has('pnpm-lock.yaml')) node('pnpm-lock.yaml', 'pnpm install --frozen-lockfile')
    else if (has('yarn.lock')) node('yarn.lock', 'yarn install --frozen-lockfile')
    else if (has('bun.lock')) node('bun.lock', 'bun install --frozen-lockfile')
    else if (has('package-lock.json')) node('package-lock.json', 'npm ci --no-audit --no-fund')
    if (has('uv.lock')) steps.push({ run: 'uv sync --frozen', ...cwd, watch: [rel('uv.lock')], ifMissing: rel('.venv') })
  }
  return steps
}

function writeTemplate(ctx) {
  const copy = ['.env', '.env.local'].filter(
    f => fs.existsSync(path.join(ctx.main, f)) && gitOk(['check-ignore', '--quiet', f], ctx.main),
  )
  const tmpl = {
    base: detectBase(ctx.main) ?? 'origin/main',
    dir: DEFAULTS.dir,
    name: DEFAULTS.name,
    size: DEFAULTS.size,
    copy,
    setup: detectSetup(ctx.main),
  }
  fs.writeFileSync(ctx.cfgFile, `${JSON.stringify(tmpl, null, 2)}\n`)
  log(`已產生 ${ctx.cfgFile}，請確認 base 和 setup 對不對，再 commit 進 repo`)
}

// ---------- 輸出 ----------

const width = s => [...s].reduce((w, ch) => w + (ch.codePointAt(0) >= 0x1100 ? 2 : 1), 0)
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)))

function printStatus(ctx, slots) {
  out(`wtpool：${ctx.poolDir}（基準 ${ctx.base ?? '未設定'}）`)
  if (!ctx.configured) out(`這個 repo 還沒有 ${CONFIG_FILE}，先跑 wtpool init`)
  else if (!slots.length) out('還沒有 worktree，先跑 wtpool init')
  for (const s of slots) {
    const where = s.branch ?? `(detached ${s.headRev ? s.headRev.slice(0, 7) : '?'})`
    const note = s.note && s.note !== STATE_LABEL[s.state] ? `  ${s.note}` : ''
    out(`${pad(s.name, 4)} ${pad(STATE_LABEL[s.state], 10)} ${pad(where, 34)}${note}`.trimEnd())
  }
}

const slotJson = s => ({
  name: s.name,
  path: s.path,
  state: s.state,
  label: STATE_LABEL[s.state],
  note: s.note,
  branch: s.branch,
  head: s.headRev ?? null,
  lease: s.meta?.lease ?? null,
  warm: s.meta?.warm ?? null,
})

// ---------- hook ----------

function readHookInput() {
  if (process.stdin.isTTY) throw new WtError('hook 指令要從 stdin 讀 Claude Code 給的 JSON')
  const text = fs.readFileSync(0, 'utf8')
  try {
    return JSON.parse(text || '{}')
  } catch {
    throw new WtError('stdin 不是 JSON')
  }
}

const sanitizeName = name =>
  String(name ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || `session-${Date.now().toString(36)}`

// Claude Code 的 command hook 一裝上就整個取代它自己建 worktree 的做法，沒辦法「這次不管」，所以：
//   - 有 .wtpool.json 的 repo 從池子拿；池子都在忙時，照 Claude Code 的做法另開一個
//   - 沒有 .wtpool.json 的 repo 照 Claude Code 的做法開：.claude/worktrees/<名稱>，分支 worktree-<名稱>

const nativeDir = ctx => path.join(ctx.main, '.claude', 'worktrees')

function globToRe(glob) {
  const body = [...glob].map(ch => (ch === '*' ? '.*' : ch === '?' ? '.' : escapeRe(ch))).join('')
  return new RegExp(`^${body}$`)
}

// .worktreeinclude：列出的檔案如果被 gitignore，就從主 checkout 複製過去。
// 支援一般路徑，以及根目錄這一層的萬用字元（例如 .env*）
function copyWorktreeInclude(ctx, dest) {
  let lines
  try {
    lines = fs.readFileSync(path.join(ctx.main, '.worktreeinclude'), 'utf8').split(/\r?\n/)
  } catch {
    return
  }
  for (const line of lines) {
    const pat = line.trim().replace(/^\//, '')
    if (!pat || pat.startsWith('#') || pat.startsWith('!')) continue
    const rels = /[*?]/.test(pat) && !pat.includes('/') ? fs.readdirSync(ctx.main).filter(n => globToRe(pat).test(n)) : [pat]
    for (const rel of rels) copyIgnored(ctx.main, dest, rel, path.basename(dest))
  }
}

function nativeCreate(ctx, name, branch) {
  const dir = path.join(nativeDir(ctx), name)
  if (listWorktrees(ctx.main).some(w => samePath(w.path, dir))) return dir // 同一個名字再開，沿用
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new WtError(`${dir} 已經存在，但不是這個 repo 的 worktree`)
  fetchBase(ctx, { timeout: 10_000 })
  const start = ctx.base && revParse(ctx.base, ctx.main) ? ctx.base : 'HEAD'
  fs.mkdirSync(nativeDir(ctx), { recursive: true })
  // 之前移除時刪不掉、留下來的空目錄，順手清掉
  for (const leftover of fs.readdirSync(nativeDir(ctx))) {
    const p = path.join(nativeDir(ctx), leftover)
    try {
      if (!samePath(p, dir) && fs.statSync(p).isDirectory() && !fs.readdirSync(p).length) fs.rmdirSync(p)
    } catch {}
  }
  if (revParse(`refs/heads/${branch}`, ctx.main)) git(['worktree', 'add', '--quiet', dir, branch], { cwd: ctx.main })
  else git(['worktree', 'add', '--quiet', '--no-track', '-b', branch, dir, start], { cwd: ctx.main })
  copyWorktreeInclude(ctx, dir)
  log(`wtpool：開了 ${dir}（${branch}，從 ${start}）`)
  return dir
}

function nativeRemove(ctx, p) {
  const info = listWorktrees(ctx.main).find(w => samePath(w.path, p))
  if (!info || !isInside(p, nativeDir(ctx))) throw new WtError(`${p} 不是 wtpool 開的 worktree，先留著`)
  const notes = []
  if (git(['status', '--porcelain'], { cwd: p }).out) {
    const label = `wtpool: ${info.branch ?? path.basename(p)} 移除前沒提交的變更`
    git(['stash', 'push', '--include-untracked', '--message', label], { cwd: p })
    notes.push('沒提交的變更收進了 git stash')
  }
  git(['worktree', 'unlock', p], { cwd: ctx.main, allowFail: true })
  const rm = git(['worktree', 'remove', '--force', p], { cwd: ctx.main, allowFail: true })
  if (!rm.ok) {
    // Windows 上目錄還被別的程式開著（例如剛離開這裡的 session）時，git 刪完檔案、拿掉登記，卻刪不掉空目錄
    if (listWorktrees(ctx.main).some(w => samePath(w.path, p))) throw new WtError(`git worktree remove 失敗：${rm.err}`)
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      notes.push(`空目錄 ${p} 暫時刪不掉，可以之後再刪`)
    }
  }
  if (info.branch) {
    const merged = gitOk(['merge-base', '--is-ancestor', info.branch, ctx.base ?? 'HEAD'], ctx.main)
    if (merged && gitOk(['branch', '-D', info.branch], ctx.main)) notes.push(`已刪除分支 ${info.branch}`)
    else notes.push(`分支 ${info.branch} 有還沒合併的 commit，留著`)
  }
  return notes
}

function hookCreate() {
  const input = readHookInput()
  const ctx = getContext(input.cwd || process.cwd())
  const name = sanitizeName(input.name)
  if (!ctx.configured) {
    out(nativeCreate(ctx, name, `worktree-${name}`))
    return EXIT.OK
  }
  const branch = ctx.cfg.hookBranch.replace('{name}', name)
  const r = take(ctx, branch, { by: `claude:${input.session_id ?? '?'}`, hook: true })
  if (r.busy) {
    log('wtpool：沒有閒著的 worktree，這次照 Claude Code 的做法另開一個（wtpool add 可以多開）')
    out(nativeCreate(ctx, name, branch))
    return EXIT.OK
  }
  out(r.slot.path)
  return EXIT.OK
}

function hookRemove() {
  const input = readHookInput()
  const p = input.worktree_path
  if (!p || !fs.existsSync(p)) return EXIT.OK // 已經不在了
  const ctx = getContext(p)
  if (ctx.configured && findSlots(ctx).some(s => samePath(s.path, p))) {
    const r = release(ctx, p, { stash: true, deleteBranch: 'hook', background: true, hook: true })
    out([`wtpool：${r.slot.name} 已放回池子`, ...r.notes].join('；'))
    return EXIT.OK
  }
  out(['wtpool：已移除 worktree', ...nativeRemove(ctx, p)].join('；'))
  return EXIT.OK
}

// ---------- 進入點 ----------

const VALUE_FLAGS = new Set(['slot', 'from'])

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h') flags.help = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = a.slice(2, eq < 0 ? undefined : eq)
      if (eq >= 0) flags[key] = a.slice(eq + 1)
      else if (VALUE_FLAGS.has(key)) {
        if (i + 1 >= argv.length) throw new WtError(`--${key} 後面要接值`)
        flags[key] = argv[++i]
      } else flags[key] = true
    } else pos.push(a)
  }
  return { pos, flags }
}

const toCount = (v, fallback) => {
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new WtError(`數量要是 0 以上的整數：${v}`)
  return n
}

function main(argv) {
  const { pos, flags } = parseArgs(argv)
  const [cmd = 'status', a1] = pos
  if (flags.help || cmd === 'help') {
    out(HELP)
    return EXIT.OK
  }
  if (flags.version || cmd === 'version') {
    out(VERSION)
    return EXIT.OK
  }
  quiet = Boolean(flags.quiet)
  const noFetch = Boolean(flags['no-fetch'])

  if (cmd === 'hook') {
    if (a1 === 'create') return hookCreate()
    if (a1 === 'remove') return hookRemove()
    throw new WtError('用法：wtpool hook create|remove')
  }

  let ctx = getContext(process.cwd())
  switch (cmd) {
    case 'status': {
      if (!noFetch && ctx.base) fetchBase(ctx, { timeout: 30_000 })
      const slots = findSlots(ctx).map(s => inspect(ctx, s))
      if (flags.json) {
        out(JSON.stringify({ repo: ctx.main, dir: ctx.poolDir, base: ctx.base, configured: ctx.configured, slots: slots.map(slotJson) }, null, 2))
      } else printStatus(ctx, slots)
      return EXIT.OK
    }
    case 'init': {
      if (!ctx.configured) {
        writeTemplate(ctx)
        ctx = getContext(process.cwd())
      }
      const want = toCount(a1, ctx.cfg.size)
      const have = findSlots(ctx).length
      if (want > have) add(ctx, want - have)
      printStatus(ctx, findSlots(ctx).map(s => inspect(ctx, s)))
      return EXIT.OK
    }
    case 'add': {
      add(ctx, Math.max(1, toCount(a1, 1)))
      printStatus(ctx, findSlots(ctx).map(s => inspect(ctx, s)))
      return EXIT.OK
    }
    case 'take': {
      if (!a1) throw new WtError('用法：wtpool take <分支> [--slot wN] [--from <ref>]')
      const r = take(ctx, a1, { slot: flags.slot, from: flags.from, noFetch })
      if (r.busy) {
        if (!quiet) printStatus(ctx, r.slots)
        log('\n沒有閒著的 worktree。要多開一個就跑：wtpool add')
        return EXIT.BUSY
      }
      out(r.slot.path)
      return EXIT.OK
    }
    case 'release': {
      release(ctx, a1, { stash: Boolean(flags.stash), noFetch })
      return EXIT.OK
    }
    case 'refresh':
      return refresh(ctx, { noFetch })
    case 'sweep':
      return sweep(ctx, { stale: Boolean(flags.stale) })
    case 'remove': {
      if (!a1) throw new WtError('用法：wtpool remove <wN>')
      remove(ctx, a1)
      return EXIT.OK
    }
    case 'which': {
      const slot = findSlots(ctx).find(s => isInside(ctx.cwd, s.path))
      if (!slot) {
        log('目前目錄不在 wtpool 的 worktree 裡')
        return EXIT.ERROR
      }
      inspect(ctx, slot)
      out(`${slot.name}\t${STATE_LABEL[slot.state]}\t${slot.branch ?? '(detached)'}\t${slot.path}`)
      return EXIT.OK
    }
    default:
      throw new WtError(`不認得的指令：${cmd}（wtpool help 看用法）`)
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  if (!(e instanceof WtError)) throw e
  process.stderr.write(`錯誤：${e.message}\n`)
  process.exitCode = e.code
}
