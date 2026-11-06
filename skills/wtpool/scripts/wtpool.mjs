#!/usr/bin/env node
// wtpool：預熱好的 git worktree 池。
//
// 池子裡的 worktree 平常停在基準分支（detached HEAD），node_modules、編譯產物都留著。
// 接到需求時挑一個閒著的開分支，做完放回去，下一個需求就不用重裝、重編。
// 設定寫在 repo 根目錄的 .wtpool.json，說明見 README.md。
//
// 只用 Node 內建模組，Node 18 以上就能跑。訊息有英文和繁體中文，用 WTPOOL_LANG 切換。

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.3.0'
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

// ---------- 訊息 ----------

const MESSAGES = {
  en: {
    states: {
      idle: 'idle',
      done: 'reclaimable',
      stale: 'maybe unused',
      busy: 'in use',
      warming: 'preparing',
      missing: 'missing',
    },
    help: () => `wtpool ${VERSION}: a pool of warm git worktrees

Usage: wtpool <command> [options]

  init [count]           write ${CONFIG_FILE} if missing, then create worktrees up to count
  status [--json]        list every worktree and its state
  take <branch> [--slot wN] [--from <ref>]
                         take an idle worktree and create the branch (or check out an existing one);
                         prints only the path on stdout
  release [wN|branch|path] [--stash]
                         put a worktree back: switch to the base branch and refresh dependencies;
                         the branch is kept
  add [count]            add more worktrees
  remove <wN>            remove an idle worktree (deletes its directory)
  refresh                move idle worktrees to the latest base branch and refresh dependencies
  sweep [--stale]        put back worktrees whose branch is merged; --stale also those with no commits for long
  which                  show which worktree the current directory is in
  hook create|remove     for Claude Code's WorktreeCreate / WorktreeRemove hooks; reads JSON on stdin

Options: --no-fetch skips git fetch, --quiet hides progress
Language: WTPOOL_LANG=en or zh-TW (default: the system language)
Exit codes: 0 success, 1 error, 2 no idle worktree`,
    gitFailed: (cmd, why) => `git ${cmd} failed: ${why}`,
    exitCode: code => `exit code ${code}`,
    cfgUnreadable: why => `can't parse ${CONFIG_FILE}: ${why}`,
    cfgBad: msg => `${CONFIG_FILE}: ${msg}`,
    cfgNotObject: 'it must be a JSON object',
    cfgUnknown: (keys, known) => `unknown field(s) ${keys} (known: ${known})`,
    cfgBase: '"base" must be a branch name, e.g. "origin/main"',
    cfgDir: '"dir" must be a path',
    cfgName: '"name" must contain exactly one {n} and no slashes, e.g. "w{n}"',
    cfgSize: '"size" must be an integer of 0 or more',
    cfgHookBranch: '"hookBranch" must contain exactly one {name}, e.g. "wt/{name}"',
    cfgCopy: '"copy" must be an array of paths',
    cfgStale: '"staleAfterHours" must be a positive number',
    cfgSetup: '"setup" must be an array',
    stepRun: i => `setup[${i}] needs "run"`,
    stepUnknown: (i, keys, known) => `setup[${i}] has unknown field(s) ${keys} (known: ${known})`,
    stepWatch: i => `setup[${i}].watch must be a path or an array of paths`,
    stepIfMissing: i => `setup[${i}].ifMissing must be a path`,
    stepCwd: i => `setup[${i}].cwd must be a path`,
    listFailed: why => `git worktree list failed: ${why}`,
    noLockReason: '(no reason given)',
    notGitRepo: cwd => `${cwd} is not inside a git repository`,
    bareRepo: 'bare repositories are not supported',
    notConfigured: main => `${main} has no ${CONFIG_FILE} yet; run wtpool init first`,
    noBase: `can't find the base branch; set "base" in ${CONFIG_FILE} (e.g. "origin/main")`,
    timedOut: s => `timed out after ${s} s`,
    fetchFailed: (remote, why, base) => `warning: git fetch ${remote} failed (${why}); using the local ${base}`,
    lockBusy: pid => `another wtpool (pid ${pid}) is working on this repo; try again shortly`,
    noteMissing: 'its directory is gone (git worktree prune cleans it up)',
    noteWarming: 'preparing (updating or installing dependencies)',
    noteDirty: 'in use (uncommitted changes)',
    noteLocked: reason => `locked by git worktree lock: ${reason}`,
    noteIdleFailed: 'idle (last preparation failed; it will rerun)',
    noteMerged: base => `branch merged into ${base}`,
    noteStale: hours => `taken ${hours} hours ago with no commits`,
    slotNotFound: key => `no worktree ${key}`,
    notInSlotPick: 'the current directory is not in a wtpool worktree; say which one (e.g. w2)',
    runStep: (name, run, cwd) => `  ${name}: ${run}${cwd ? ` (in ${cwd})` : ''}`,
    prepFailed: (name, run, why) => `${name}: preparation failed: ${run} (${why})`,
    copyNotFile: rel => `warning: only files can be copied; skipping ${rel}`,
    copyNotIgnored: rel => `warning: ${rel} is not gitignored; skipping`,
    copied: (label, rel) => `  ${label}: copied ${rel}`,
    branchExistsFrom: b => `branch ${b} already exists, so --from can't be used`,
    descExisting: 'existing branch',
    descFrom: ref => `new branch from ${ref}`,
    descRemote: ref => `continuing ${ref}`,
    refNotFound: ref => `can't find ${ref}`,
    baseNotFound: (base, canFetch) => `can't find ${base}${canFetch ? ' (try git fetch)' : ''}`,
    badBranch: b => `invalid branch name: ${b}`,
    branchElsewhere: (b, p) => `${b} is already checked out at ${p}`,
    slotUnavailable: (name, label, note) => `${name} can't be used now: ${label} (${note})`,
    reuse: (b, name) => `${b} is already in ${name}; reusing it`,
    took: (name, desc, b) => `${name}: ${b} (${desc})`,
    slotWarming: name => `${name} is being prepared; release it a little later`,
    slotDirty: name =>
      `${name} has uncommitted changes; commit or clean them up first (or add --stash to keep them in git stash)`,
    stashRelease: what => `wtpool: ${what} — uncommitted changes before release`,
    stashRemove: what => `wtpool: ${what} — uncommitted changes before removal`,
    noteStashed: 'uncommitted changes were saved to git stash (see git stash list)',
    noteStashedShort: 'uncommitted changes were saved to git stash',
    noteAhead: (b, n, base) => `branch ${b} has ${n} commit(s) not in ${base}; the branch is kept`,
    noteDeletedMerged: b => `deleted merged branch ${b}`,
    released: (name, base) => `${name} released (${base}, detached)`,
    pathTaken: p => `${p} already exists but is not a worktree of this repo; check what's in it first`,
    creating: (n, base, p) => `creating w${n} (${base}) → ${p}`,
    updated: (name, base) => `${name}: updated to ${base}`,
    nothingToRefresh: 'no idle worktrees to update',
    nothingToSweep: 'no worktrees to put back',
    removeOnlyIdle: (name, label) => `${name} is "${label}"; only idle worktrees can be removed`,
    removing: (name, p) => `removing ${name}: ${p}`,
    removed: name => `${name} removed`,
    wroteConfig: file => `wrote ${file}; check that base and setup are right, then commit it`,
    statusHeader: (dir, base) => `wtpool: ${dir} (base ${base ?? 'not set'})`,
    statusNoConfig: `this repo has no ${CONFIG_FILE} yet; run wtpool init`,
    statusEmpty: 'no worktrees yet; run wtpool init',
    hookTty: "hook commands read Claude Code's JSON from stdin",
    hookBadJson: 'stdin is not JSON',
    nativeTaken: dir => `${dir} already exists but is not a worktree of this repo`,
    nativeCreated: (dir, b, start) => `wtpool: created ${dir} (${b}, from ${start})`,
    nativeNotOurs: p => `${p} was not created by wtpool; leaving it alone`,
    removeFailed: why => `git worktree remove failed: ${why}`,
    emptyDirLeft: p => `the empty directory ${p} can't be deleted yet; remove it later`,
    noteDeletedBranch: b => `deleted branch ${b}`,
    noteKeptBranch: b => `branch ${b} has unmerged commits; kept`,
    hookBusy: 'wtpool: no idle worktree, so this one is created the way Claude Code does (wtpool add grows the pool)',
    hookReleased: name => `wtpool: ${name} is back in the pool`,
    hookRemoved: 'wtpool: worktree removed',
    sep: '; ',
    needsValue: key => `--${key} needs a value`,
    badCount: v => `count must be an integer of 0 or more: ${v}`,
    usageHook: 'usage: wtpool hook create|remove',
    usageTake: 'usage: wtpool take <branch> [--slot wN] [--from <ref>]',
    usageRemove: 'usage: wtpool remove <wN>',
    noIdle: '\nNo idle worktree. To add one, run: wtpool add',
    notInSlot: 'the current directory is not in a wtpool worktree',
    unknownCommand: cmd => `unknown command: ${cmd} (see wtpool help)`,
    errorPrefix: 'error: ',
  },

  'zh-TW': {
    states: {
      idle: '閒置',
      done: '可回收',
      stale: '可能沒在用',
      busy: '使用中',
      warming: '準備中',
      missing: '不見了',
    },
    help: () => `wtpool ${VERSION}：預熱好的 git worktree 池

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
語言：WTPOOL_LANG=en 或 zh-TW（沒設就跟系統語言）
結束碼：0 成功，1 錯誤，2 沒有閒著的 worktree`,
    gitFailed: (cmd, why) => `git ${cmd} 失敗：${why}`,
    exitCode: code => `結束碼 ${code}`,
    cfgUnreadable: why => `${CONFIG_FILE} 讀不懂：${why}`,
    cfgBad: msg => `${CONFIG_FILE}：${msg}`,
    cfgNotObject: '內容要是一個 JSON 物件',
    cfgUnknown: (keys, known) => `有不認得的欄位 ${keys}（可用的有 ${known}）`,
    cfgBase: '"base" 要是分支名稱，例如 "origin/main"',
    cfgDir: '"dir" 要是路徑',
    cfgName: '"name" 要剛好含一個 {n}、不能有斜線，例如 "w{n}"',
    cfgSize: '"size" 要是 0 以上的整數',
    cfgHookBranch: '"hookBranch" 要剛好含一個 {name}，例如 "wt/{name}"',
    cfgCopy: '"copy" 要是路徑的陣列',
    cfgStale: '"staleAfterHours" 要是正數',
    cfgSetup: '"setup" 要是陣列',
    stepRun: i => `setup[${i}] 要有 "run"`,
    stepUnknown: (i, keys, known) => `setup[${i}] 有不認得的欄位 ${keys}（可用的有 ${known}）`,
    stepWatch: i => `setup[${i}].watch 要是路徑或路徑的陣列`,
    stepIfMissing: i => `setup[${i}].ifMissing 要是路徑`,
    stepCwd: i => `setup[${i}].cwd 要是路徑`,
    listFailed: why => `git worktree list 失敗：${why}`,
    noLockReason: '（沒寫原因）',
    notGitRepo: cwd => `${cwd} 不在 git repo 裡`,
    bareRepo: '不支援 bare repo',
    notConfigured: main => `${main} 還沒有 ${CONFIG_FILE}，先跑 wtpool init`,
    noBase: `找不到基準分支，請在 ${CONFIG_FILE} 設定 "base"（例如 "origin/main"）`,
    timedOut: s => `超過 ${s} 秒`,
    fetchFailed: (remote, why, base) => `警告：git fetch ${remote} 失敗（${why}），先用本機現有的 ${base}`,
    lockBusy: pid => `另一個 wtpool（pid ${pid}）正在處理這個 repo，稍後再試`,
    noteMissing: '目錄不見了（可以跑 git worktree prune 清掉）',
    noteWarming: '準備中（正在更新或安裝套件）',
    noteDirty: '使用中（有未提交的變更）',
    noteLocked: reason => `被 git worktree lock 鎖住：${reason}`,
    noteIdleFailed: '閒置（上次準備失敗，下次會重跑）',
    noteMerged: base => `分支已合併進 ${base}`,
    noteStale: hours => `拿走 ${hours} 小時都沒有 commit`,
    slotNotFound: key => `找不到 worktree ${key}`,
    notInSlotPick: '目前目錄不在 wtpool 的 worktree 裡，請指定要哪一個（例如 w2）',
    runStep: (name, run, cwd) => `  ${name}：${run}${cwd ? `（在 ${cwd}）` : ''}`,
    prepFailed: (name, run, why) => `${name} 準備失敗：${run}（${why}）`,
    copyNotFile: rel => `警告：只能複製檔案，略過 ${rel}`,
    copyNotIgnored: rel => `警告：${rel} 沒有被 .gitignore 忽略，略過`,
    copied: (label, rel) => `  ${label}：複製 ${rel}`,
    branchExistsFrom: b => `分支 ${b} 已經存在，不能再指定 --from`,
    descExisting: '切到既有的分支',
    descFrom: ref => `從 ${ref} 開新分支`,
    descRemote: ref => `從 ${ref} 接著做`,
    refNotFound: ref => `找不到 ${ref}`,
    baseNotFound: (base, canFetch) => `找不到 ${base}${canFetch ? '（先 git fetch 看看）' : ''}`,
    badBranch: b => `分支名稱不合法：${b}`,
    branchElsewhere: (b, p) => `${b} 已經在 ${p} 用著了`,
    slotUnavailable: (name, label, note) => `${name} 現在不能用：${label}（${note}）`,
    reuse: (b, name) => `${b} 已經在 ${name}，沿用`,
    took: (name, desc, b) => `${name}：${desc} ${b}`,
    slotWarming: name => `${name} 正在準備中，等一下再放回`,
    slotDirty: name => `${name} 有未提交的變更，先 commit 或清掉再放回（確定不要了可以加 --stash 收進 git stash）`,
    stashRelease: what => `wtpool: ${what} 放回前沒提交的變更`,
    stashRemove: what => `wtpool: ${what} 移除前沒提交的變更`,
    noteStashed: '沒提交的變更收進了 git stash（git stash list 看得到）',
    noteStashedShort: '沒提交的變更收進了 git stash',
    noteAhead: (b, n, base) => `分支 ${b} 還有 ${n} 個 commit 沒進 ${base}，分支會留著`,
    noteDeletedMerged: b => `已刪除合併過的分支 ${b}`,
    released: (name, base) => `${name} 已放回（${base}，detached）`,
    pathTaken: p => `${p} 已經存在，但不是這個 repo 的 worktree，請先確認裡面的東西`,
    creating: (n, base, p) => `建立 w${n}（${base}）→ ${p}`,
    updated: (name, base) => `${name}：已更新到 ${base}`,
    nothingToRefresh: '沒有閒置的 worktree 要更新',
    nothingToSweep: '沒有可以放回的 worktree',
    removeOnlyIdle: (name, label) => `${name} 現在是「${label}」，只能移除閒置的`,
    removing: (name, p) => `移除 ${name}：${p}`,
    removed: name => `${name} 已移除`,
    wroteConfig: file => `已產生 ${file}，請確認 base 和 setup 對不對，再 commit 進 repo`,
    statusHeader: (dir, base) => `wtpool：${dir}（基準 ${base ?? '未設定'}）`,
    statusNoConfig: `這個 repo 還沒有 ${CONFIG_FILE}，先跑 wtpool init`,
    statusEmpty: '還沒有 worktree，先跑 wtpool init',
    hookTty: 'hook 指令要從 stdin 讀 Claude Code 給的 JSON',
    hookBadJson: 'stdin 不是 JSON',
    nativeTaken: dir => `${dir} 已經存在，但不是這個 repo 的 worktree`,
    nativeCreated: (dir, b, start) => `wtpool：開了 ${dir}（${b}，從 ${start}）`,
    nativeNotOurs: p => `${p} 不是 wtpool 開的 worktree，先留著`,
    removeFailed: why => `git worktree remove 失敗：${why}`,
    emptyDirLeft: p => `空目錄 ${p} 暫時刪不掉，可以之後再刪`,
    noteDeletedBranch: b => `已刪除分支 ${b}`,
    noteKeptBranch: b => `分支 ${b} 有還沒合併的 commit，留著`,
    hookBusy: 'wtpool：沒有閒著的 worktree，這次照 Claude Code 的做法另開一個（wtpool add 可以多開）',
    hookReleased: name => `wtpool：${name} 已放回池子`,
    hookRemoved: 'wtpool：已移除 worktree',
    sep: '；',
    needsValue: key => `--${key} 後面要接值`,
    badCount: v => `數量要是 0 以上的整數：${v}`,
    usageHook: '用法：wtpool hook create|remove',
    usageTake: '用法：wtpool take <分支> [--slot wN] [--from <ref>]',
    usageRemove: '用法：wtpool remove <wN>',
    noIdle: '\n沒有閒著的 worktree。要多開一個就跑：wtpool add',
    notInSlot: '目前目錄不在 wtpool 的 worktree 裡',
    unknownCommand: cmd => `不認得的指令：${cmd}（wtpool help 看用法）`,
    errorPrefix: '錯誤：',
  },
}

// 語言：WTPOOL_LANG（en、zh-TW）優先；沒設的話 Windows 看系統的顯示語言（Git Bash 一律把 LANG 設成
// en_US，不準），其他系統看 LC_ALL / LC_MESSAGES / LANG。都不是中文就用英文。
function pickLang(env = process.env) {
  const tidy = v =>
    String(v ?? '')
      .trim()
      .toLowerCase()
      .replace(/_/g, '-')
  const wanted = tidy(env.WTPOOL_LANG)
  if (wanted.startsWith('zh')) return 'zh-TW'
  if (wanted.startsWith('en')) return 'en'
  let intl = ''
  try {
    intl = Intl.DateTimeFormat().resolvedOptions().locale
  } catch {}
  const sys = IS_WIN ? intl : env.LC_ALL || env.LC_MESSAGES || env.LANG || intl
  return tidy(sys).startsWith('zh') ? 'zh-TW' : 'en'
}

const M = MESSAGES[pickLang()]

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
  if (!res.ok && !allowFail) throw new WtError(M.gitFailed(args.join(' '), res.err || M.exitCode(r.status)))
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
    throw new WtError(M.cfgUnreadable(e.message))
  }
  const bad = msg => {
    throw new WtError(M.cfgBad(msg))
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(M.cfgNotObject)
  const unknown = Object.keys(raw).filter(k => k !== '$schema' && !(k in DEFAULTS))
  if (unknown.length) bad(M.cfgUnknown(unknown.join(', '), Object.keys(DEFAULTS).join(', ')))

  const cfg = { ...DEFAULTS, ...raw }
  if (cfg.base !== null && (typeof cfg.base !== 'string' || !cfg.base)) bad(M.cfgBase)
  if (typeof cfg.dir !== 'string' || !cfg.dir) bad(M.cfgDir)
  if (typeof cfg.name !== 'string' || cfg.name.split('{n}').length !== 2 || /[\\/]/.test(cfg.name)) bad(M.cfgName)
  if (!Number.isInteger(cfg.size) || cfg.size < 0) bad(M.cfgSize)
  if (typeof cfg.hookBranch !== 'string' || cfg.hookBranch.split('{name}').length !== 2) bad(M.cfgHookBranch)
  if (!Array.isArray(cfg.copy) || cfg.copy.some(c => typeof c !== 'string' || !c)) bad(M.cfgCopy)
  if (typeof cfg.staleAfterHours !== 'number' || !(cfg.staleAfterHours > 0)) bad(M.cfgStale)
  if (!Array.isArray(cfg.setup)) bad(M.cfgSetup)
  cfg.setup = cfg.setup.map((step, i) => {
    const s = typeof step === 'string' ? { run: step } : step
    if (!s || typeof s !== 'object' || typeof s.run !== 'string' || !s.run) bad(M.stepRun(i))
    const extra = Object.keys(s).filter(k => !STEP_KEYS.includes(k))
    if (extra.length) bad(M.stepUnknown(i, extra.join(', '), STEP_KEYS.join(', ')))
    const watch = s.watch === undefined ? [] : Array.isArray(s.watch) ? s.watch : [s.watch]
    if (watch.some(w => typeof w !== 'string' || !w)) bad(M.stepWatch(i))
    if (s.ifMissing !== undefined && (typeof s.ifMissing !== 'string' || !s.ifMissing)) bad(M.stepIfMissing(i))
    if (s.cwd !== undefined && (typeof s.cwd !== 'string' || !s.cwd)) bad(M.stepCwd(i))
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
  if (r.error || r.status !== 0) throw new WtError(M.listFailed((r.stderr || r.error?.message || '').trim()))
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
    else if (key === 'locked') cur.locked = val || M.noLockReason
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
  if (!gitOk(['rev-parse', '--show-toplevel'], cwd)) throw new WtError(M.notGitRepo(cwd))
  const common = path.resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }).out)
  const mainWt = listWorktrees(cwd)[0]
  if (!mainWt || mainWt.bare) throw new WtError(M.bareRepo)
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
  if (!ctx.configured) throw new WtError(M.notConfigured(ctx.main))
}

function requireBase(ctx) {
  if (!ctx.base) throw new WtError(M.noBase)
  return ctx.base
}

function fetchBase(ctx, { timeout = 120_000 } = {}) {
  if (!ctx.remote) return
  const r = git(['fetch', '--quiet', '--prune', ctx.remote], { cwd: ctx.main, timeout, allowFail: true })
  if (r.ok) return
  log(M.fetchFailed(ctx.remote, r.timedOut ? M.timedOut(timeout / 1000) : r.err, ctx.base))
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
      if (Date.now() - started > waitMs) throw new WtError(M.lockBusy(holder?.pid ?? '?'))
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
  if (!fs.existsSync(slot.path)) return set('missing', M.noteMissing)
  slot.admin = path.resolve(git(['rev-parse', '--absolute-git-dir'], { cwd: slot.path }).out)
  slot.meta = readMeta(slot)
  slot.headRev = git(['rev-parse', 'HEAD'], { cwd: slot.path }).out
  slot.dirty = git(['status', '--porcelain'], { cwd: slot.path }).out !== ''
  const lease = slot.meta.lease

  if (lease?.kind === 'warm' && isAlive(lease.pid)) return set('warming', M.noteWarming)
  if (slot.dirty) return set('busy', M.noteDirty)
  if (!slot.branch) {
    if (slot.locked && lease?.kind !== 'take') return set('busy', M.noteLocked(slot.locked))
    return set('idle', slot.meta.warm?.ok === false ? M.noteIdleFailed : M.states.idle)
  }

  const merged = Boolean(ctx.base) && gitOk(['merge-base', '--is-ancestor', 'HEAD', ctx.base], slot.path)
  if (lease?.kind === 'take' && lease.branch === slot.branch) {
    if (merged && slot.headRev !== lease.startRev) return set('done', M.noteMerged(ctx.base))
    const hours = (Date.now() - Date.parse(lease.since)) / 36e5
    if (slot.headRev === lease.startRev && hours >= ctx.cfg.staleAfterHours) {
      return set('stale', M.noteStale(Math.floor(hours)))
    }
    return set('busy', M.states.busy)
  }
  // 沒有 wtpool 的租約（舊版腳本拿的、或手動切的分支）：推過而且全部合併才算做完
  const upstream = git(['config', '--get', `branch.${slot.branch}.merge`], { cwd: ctx.main, allowFail: true }).out
  if (merged && upstream && upstream !== `refs/heads/${ctx.baseBranch}`) return set('done', M.noteMerged(ctx.base))
  return set('busy', M.states.busy)
}

function pickSlot(slots, key) {
  const k = String(key)
  const m = /^w?(\d+)$/i.exec(k)
  const slot = slots.find(s => (m && s.n === Number(m[1])) || path.basename(s.path).toLowerCase() === k.toLowerCase())
  if (!slot) throw new WtError(M.slotNotFound(key))
  return slot
}

function resolveSlot(ctx, slots, key) {
  if (!key) {
    const here = slots.find(s => isInside(ctx.cwd, s.path))
    if (!here) throw new WtError(M.notInSlotPick)
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
    log(M.runStep(slot.name, step.run, step.cwd))
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
      throw new WtError(M.prepFailed(slot.name, step.run, r.error?.message ?? M.exitCode(r.status)))
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
    log(M.copyNotFile(rel))
    return
  }
  if (!gitOk(['check-ignore', '--quiet', rel], main)) {
    log(M.copyNotIgnored(rel))
    return
  }
  try {
    if (fs.readFileSync(dst).equals(fs.readFileSync(src))) return
  } catch {}
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  log(M.copied(label, rel))
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
    if (from) throw new WtError(M.branchExistsFrom(branch))
    return { args: [branch], rev: local, desc: M.descExisting }
  }
  if (from) {
    const rev = revParse(from, ctx.main)
    if (!rev) throw new WtError(M.refNotFound(from))
    return { args: ['--no-track', '-c', branch, from], rev, desc: M.descFrom(from) }
  }
  if (ctx.remote) {
    const remoteRef = `${ctx.remote}/${branch}`
    const rev = revParse(`refs/remotes/${remoteRef}`, ctx.main)
    if (rev) return { args: ['--track', '-c', branch, remoteRef], rev, desc: M.descRemote(remoteRef) }
  }
  const rev = revParse(ctx.base, ctx.main)
  if (!rev) throw new WtError(M.baseNotFound(ctx.base, Boolean(ctx.remote)))
  // --no-track：不要把基準分支設成 upstream，免得之後 git push 推到基準分支
  return { args: ['--no-track', '-c', branch, ctx.base], rev, desc: M.descFrom(ctx.base) }
}

// opts.hook：從 Claude Code 的 hook 呼叫，fetch 不要等太久
function take(ctx, branch, opts = {}) {
  requireConfig(ctx)
  requireBase(ctx)
  if (!gitOk(['check-ref-format', '--branch', branch], ctx.main)) throw new WtError(M.badBranch(branch))
  if (!opts.noFetch) fetchBase(ctx, { timeout: opts.hook ? 10_000 : 120_000 })

  const picked = withLock(ctx, () => {
    const slots = findSlots(ctx).map(s => inspect(ctx, s))
    const mine = slots.find(s => s.branch === branch)
    if (mine) return { slot: mine, again: true }
    const elsewhere = listWorktrees(ctx.main).find(w => w.branch === branch)
    if (elsewhere) throw new WtError(M.branchElsewhere(branch, elsewhere.path))

    const target = resolveTarget(ctx, branch, opts.from)
    let usable = slots.filter(s => s.state === 'idle' || s.state === 'done')
    if (opts.slot) {
      const s = pickSlot(slots, opts.slot)
      if (!usable.includes(s)) throw new WtError(M.slotUnavailable(s.name, M.states[s.state], s.note))
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
    log(M.reuse(branch, slot.name))
    return picked
  }
  copyFiles(ctx, slot)
  runWarm(ctx, slot, picked.steps)
  log(M.took(slot.name, picked.desc, branch))
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
    if (slot.state === 'warming') throw new WtError(M.slotWarming(slot.name))
    const notes = []
    if (slot.dirty) {
      if (!opts.stash) throw new WtError(M.slotDirty(slot.name))
      git(['stash', 'push', '--include-untracked', '--message', M.stashRelease(slot.branch ?? slot.name)], {
        cwd: slot.path,
      })
      notes.push(M.noteStashed)
    }
    const branch = slot.branch
    if (branch) {
      const ahead = Number(git(['rev-list', '--count', `${ctx.base}..HEAD`], { cwd: slot.path, allowFail: true }).out || 0)
      if (ahead > 0) notes.push(M.noteAhead(branch, ahead, ctx.base))
    }
    git(['switch', '--quiet', '--detach', ctx.base], { cwd: slot.path })
    git(['worktree', 'unlock', slot.path], { cwd: ctx.main, allowFail: true })
    const del = opts.deleteBranch === true || (opts.deleteBranch === 'hook' && ctx.hookRe.test(branch ?? ''))
    if (branch && del && gitOk(['branch', '-d', branch], slot.path)) notes.push(M.noteDeletedMerged(branch))
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
  log(M.released(slot.name, ctx.base))
  return r
}

function add(ctx, count = 1) {
  requireConfig(ctx)
  requireBase(ctx)
  fetchBase(ctx)
  if (!revParse(ctx.base, ctx.main)) throw new WtError(M.refNotFound(ctx.base))

  const created = withLock(ctx, () => {
    const used = new Set(findSlots(ctx).map(s => s.n))
    const made = []
    for (let n = 1; made.length < count; n++) {
      if (used.has(n)) continue
      const p = path.join(ctx.poolDir, ctx.cfg.name.replace('{n}', String(n)))
      if (fs.existsSync(p)) throw new WtError(M.pathTaken(p))
      fs.mkdirSync(ctx.poolDir, { recursive: true })
      log(M.creating(n, ctx.base, p))
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
  if (!baseRev) throw new WtError(M.refNotFound(ctx.base))

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
      log(M.updated(slot.name, ctx.base))
    } catch (e) {
      failed++
      log(e.message)
    } finally {
      clearWarmLease(slot)
    }
  }
  if (!targets.length) log(M.nothingToRefresh)
  return failed ? EXIT.ERROR : EXIT.OK
}

function sweep(ctx, opts = {}) {
  requireConfig(ctx)
  requireBase(ctx)
  fetchBase(ctx)
  const slots = findSlots(ctx).map(s => inspect(ctx, s))
  const wanted = slots.filter(s => s.state === 'done' || (opts.stale && s.state === 'stale'))
  if (!wanted.length) log(M.nothingToSweep)
  let failed = 0
  for (const s of wanted) {
    try {
      release(ctx, s.path, { noFetch: true, deleteBranch: 'hook' })
    } catch (e) {
      failed++
      log(`${s.name}: ${e.message}`)
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
    if (s.state !== 'idle') throw new WtError(M.removeOnlyIdle(s.name, M.states[s.state]))
    git(['worktree', 'unlock', s.path], { cwd: ctx.main, allowFail: true })
    log(M.removing(s.name, s.path))
    git(['worktree', 'remove', s.path], { cwd: ctx.main })
    return s
  })
  log(M.removed(slot.name))
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
  log(M.wroteConfig(ctx.cfgFile))
}

// ---------- 輸出 ----------

const width = s => [...s].reduce((w, ch) => w + (ch.codePointAt(0) >= 0x1100 ? 2 : 1), 0)
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)))

function printStatus(ctx, slots) {
  out(M.statusHeader(ctx.poolDir, ctx.base))
  if (!ctx.configured) out(M.statusNoConfig)
  else if (!slots.length) out(M.statusEmpty)
  const labelWidth = Math.max(...Object.values(M.states).map(width)) + 1
  for (const s of slots) {
    const where = s.branch ?? `(detached ${s.headRev ? s.headRev.slice(0, 7) : '?'})`
    const note = s.note && s.note !== M.states[s.state] ? `  ${s.note}` : ''
    out(`${pad(s.name, 4)} ${pad(M.states[s.state], labelWidth)} ${pad(where, 34)}${note}`.trimEnd())
  }
}

const slotJson = s => ({
  name: s.name,
  path: s.path,
  state: s.state,
  label: M.states[s.state],
  note: s.note,
  branch: s.branch,
  head: s.headRev ?? null,
  lease: s.meta?.lease ?? null,
  warm: s.meta?.warm ?? null,
})

// ---------- hook ----------

function readHookInput() {
  if (process.stdin.isTTY) throw new WtError(M.hookTty)
  const text = fs.readFileSync(0, 'utf8')
  try {
    return JSON.parse(text || '{}')
  } catch {
    throw new WtError(M.hookBadJson)
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
    const rels =
      /[*?]/.test(pat) && !pat.includes('/') ? fs.readdirSync(ctx.main).filter(n => globToRe(pat).test(n)) : [pat]
    for (const rel of rels) copyIgnored(ctx.main, dest, rel, path.basename(dest))
  }
}

function nativeCreate(ctx, name, branch) {
  const dir = path.join(nativeDir(ctx), name)
  if (listWorktrees(ctx.main).some(w => samePath(w.path, dir))) return dir // 同一個名字再開，沿用
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new WtError(M.nativeTaken(dir))
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
  log(M.nativeCreated(dir, branch, start))
  return dir
}

function nativeRemove(ctx, p) {
  const info = listWorktrees(ctx.main).find(w => samePath(w.path, p))
  if (!info || !isInside(p, nativeDir(ctx))) throw new WtError(M.nativeNotOurs(p))
  const notes = []
  if (git(['status', '--porcelain'], { cwd: p }).out) {
    git(['stash', 'push', '--include-untracked', '--message', M.stashRemove(info.branch ?? path.basename(p))], {
      cwd: p,
    })
    notes.push(M.noteStashedShort)
  }
  git(['worktree', 'unlock', p], { cwd: ctx.main, allowFail: true })
  const rm = git(['worktree', 'remove', '--force', p], { cwd: ctx.main, allowFail: true })
  if (!rm.ok) {
    // Windows 上目錄還被別的程式開著（例如剛離開這裡的 session）時，git 刪完檔案、拿掉登記，卻刪不掉空目錄
    if (listWorktrees(ctx.main).some(w => samePath(w.path, p))) throw new WtError(M.removeFailed(rm.err))
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      notes.push(M.emptyDirLeft(p))
    }
  }
  if (info.branch) {
    const merged = gitOk(['merge-base', '--is-ancestor', info.branch, ctx.base ?? 'HEAD'], ctx.main)
    if (merged && gitOk(['branch', '-D', info.branch], ctx.main)) notes.push(M.noteDeletedBranch(info.branch))
    else notes.push(M.noteKeptBranch(info.branch))
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
    log(M.hookBusy)
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
    out([M.hookReleased(r.slot.name), ...r.notes].join(M.sep))
    return EXIT.OK
  }
  out([M.hookRemoved, ...nativeRemove(ctx, p)].join(M.sep))
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
        if (i + 1 >= argv.length) throw new WtError(M.needsValue(key))
        flags[key] = argv[++i]
      } else flags[key] = true
    } else pos.push(a)
  }
  return { pos, flags }
}

const toCount = (v, fallback) => {
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new WtError(M.badCount(v))
  return n
}

function main(argv) {
  const { pos, flags } = parseArgs(argv)
  const [cmd = 'status', a1] = pos
  if (flags.help || cmd === 'help') {
    out(M.help())
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
    throw new WtError(M.usageHook)
  }

  let ctx = getContext(process.cwd())
  switch (cmd) {
    case 'status': {
      if (!noFetch && ctx.base) fetchBase(ctx, { timeout: 30_000 })
      const slots = findSlots(ctx).map(s => inspect(ctx, s))
      if (flags.json) {
        const data = { repo: ctx.main, dir: ctx.poolDir, base: ctx.base, configured: ctx.configured }
        out(JSON.stringify({ ...data, slots: slots.map(slotJson) }, null, 2))
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
      printStatus(
        ctx,
        findSlots(ctx).map(s => inspect(ctx, s)),
      )
      return EXIT.OK
    }
    case 'add': {
      add(ctx, Math.max(1, toCount(a1, 1)))
      printStatus(
        ctx,
        findSlots(ctx).map(s => inspect(ctx, s)),
      )
      return EXIT.OK
    }
    case 'take': {
      if (!a1) throw new WtError(M.usageTake)
      const r = take(ctx, a1, { slot: flags.slot, from: flags.from, noFetch })
      if (r.busy) {
        if (!quiet) printStatus(ctx, r.slots)
        log(M.noIdle)
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
      if (!a1) throw new WtError(M.usageRemove)
      remove(ctx, a1)
      return EXIT.OK
    }
    case 'which': {
      const slot = findSlots(ctx).find(s => isInside(ctx.cwd, s.path))
      if (!slot) {
        log(M.notInSlot)
        return EXIT.ERROR
      }
      inspect(ctx, slot)
      out(`${slot.name}\t${M.states[slot.state]}\t${slot.branch ?? '(detached)'}\t${slot.path}`)
      return EXIT.OK
    }
    default:
      throw new WtError(M.unknownCommand(cmd))
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  if (!(e instanceof WtError)) throw e
  process.stderr.write(`${M.errorPrefix}${e.message}\n`)
  process.exitCode = e.code
}
