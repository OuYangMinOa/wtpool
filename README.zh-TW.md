# wtpool：預熱好的 git worktree 池

[English](README.md) | **繁體中文**

同時開好幾個分支（或讓好幾個 AI agent 平行工作）時，每個 worktree 都要重裝 node_modules、
重新編譯，往往比改程式還久。wtpool 讓 repo 保留一組固定的 worktree：平常停在基準分支，
套件和編譯產物都留著；接需求時挑一個閒著的開分支，做完放回去，下一個需求拿到就能直接用。

- **CLI**：`skills/wtpool/scripts/wtpool.mjs`，Node 18 以上、零依賴，Windows / macOS / Linux 都能跑。
- **Agent skill**：`skills/wtpool` 是 [Agent Skills](https://agentskills.io) 格式，CLI 就放在裡面。它讓 agent
  知道開工前要 `take`、做完要 `release`、池子都在忙要先問人。Codex、Cursor、Gemini CLI、GitHub Copilot、
  OpenCode、Claude Code 這些會讀 skill 的 agent 都能用。
- **Claude Code plugin**：上面的 skill，加上接手 Claude Code 內建 worktree 的 hook（`claude --worktree`、
  `EnterWorktree`、subagent 的 `isolation: worktree`、背景 session），改從池子拿。

## 安裝

### Claude Code plugin

在 Claude Code 裡輸入：

```
/plugin install wtpool --marketplace OuYangMinOa/wtpool
```

問要不要加入 marketplace 時按 `y`，再選安裝範圍（見下面的建議）。也可以在終端機裡跑：

```
claude plugin install wtpool --marketplace OuYangMinOa/wtpool --scope local
```

**建議裝在 project 或 local scope**，只在有 `.wtpool.json` 的 repo 啟用。plugin 的 hook 一啟用就整個取代
Claude Code 建 worktree 的做法；沒有 `.wtpool.json` 的 repo 雖然會照 Claude Code 的做法開
（`.claude/worktrees/<名稱>`、分支 `worktree-<名稱>`），但少了 Claude Code 自己的定期清理，subagent 用過的 worktree 要自己清。

想讓 clone 這個 repo 的每個人都自動裝上，在 repo 的 `.claude/settings.json` 加：

```json
{
  "extraKnownMarketplaces": {
    "wtpool": { "source": { "source": "github", "repo": "OuYangMinOa/wtpool" } }
  },
  "enabledPlugins": { "wtpool@wtpool": true }
}
```

開發 plugin 本身時，用 `claude --plugin-dir <wtpool 的資料夾>` 直接從資料夾載入。

### 其他 agent（Codex、Cursor、Gemini CLI、Copilot…）

```
npx skills add OuYangMinOa/wtpool
```

[skills](https://github.com/vercel-labs/skills) 會找出你裝了哪些 agent，把 skill 裝給它們，預設裝在專案裡
（`.agents/skills/`，Claude Code 是 `.claude/skills/`）；加 `-g` 就所有專案都能用。CLI 在 skill 裡面，
只要有 Node 18 以上就好。也可以自己把 `skills/wtpool` 資料夾複製到 agent 的 skills 資料夾。
Claude Code 請裝 plugin，skill 一樣，還多了 hook。

其他 agent 沒有 hook，它們自己的 worktree 功能還是會在池子外開新的；skill 會讓它們改用 `wtpool take` / `release`。

### 不支援 skill 的 agent：`AGENTS.md`

agent 不讀 skill，或想確保在 repo 裡工作的每個 agent 都知道有池子，就裝好 CLI（見下面），
在 repo 的 `AGENTS.md`（或 `CLAUDE.md`）加一段：

```markdown
## Worktrees

This repo uses wtpool (see `.wtpool.json`). Before working on a new branch, run `wtpool take <branch>` and do all
the work in the path it prints; don't edit the main checkout or run `git worktree add`. Once the branch is merged,
run `wtpool release`. If `take` exits with code 2, every worktree is busy: ask before running `wtpool add`.
```

### 只用 CLI

```
npm install -g github:OuYangMinOa/wtpool   # 之後就有 wtpool 指令
# 或 clone 下來直接跑
node wtpool/skills/wtpool/scripts/wtpool.mjs status
```

## 開始使用

在 repo 裡：

```
wtpool init        # 產生 .wtpool.json（猜好基準分支和安裝指令），並建立 worktree
```

確認 `.wtpool.json` 的 `base` 和 `setup` 對不對，再 commit 進 repo，之後每個 clone 這個 repo 的人都能用。

```
wtpool take feature/login      # 挑一個閒著的開分支，stdout 印出路徑
cd "$(wtpool take feature/login)"   # 或直接切過去
wtpool status                  # 看每個 worktree 在做什麼
wtpool release w2              # 做完放回（在那個 worktree 裡可以省略 w2）
wtpool sweep                   # 分支已經合併的全部放回
```

## 設定：`.wtpool.json`

放在 repo 根目錄，例如：

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

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `base` | origin 的預設分支 | 新分支從這裡開，放回時也切回這裡。開工和放回前都會先 `git fetch` |
| `dir` | `../{repo}-worktrees` | worktree 放的目錄，相對於 repo 根目錄；`{repo}` 是 repo 資料夾名稱 |
| `name` | `w{n}` | worktree 的資料夾名稱，`{n}` 是編號。改成既有的命名就能直接接手手動建的 worktree |
| `size` | `2` | `wtpool init` 預設建立幾個 |
| `setup` | `[]` | 準備步驟，見下面 |
| `copy` | `[]` | 從主 checkout 複製到 worktree 的檔案。只複製被 gitignore 的（例如 `.env`），不然 worktree 會變髒 |
| `hookBranch` | `wt/{name}` | Claude Code 內建 worktree 從池子拿時用的分支名稱，`{name}` 是 Claude Code 給的名字 |
| `staleAfterHours` | `24` | 拿走超過這麼久都沒有 commit，`status` 標成「可能沒在用」，`sweep --stale` 會放回 |

### setup 步驟

每一步是 `{ "run", "cwd", "watch", "ifMissing" }`（也可以只寫指令字串）：

- `run`：要跑的指令，經過系統 shell（Windows 是 cmd.exe）。環境變數有 `WTPOOL_SLOT`（編號）和 `WTPOOL_PATH`。
- `cwd`：在哪個子目錄跑，預設 repo 根目錄。
- `watch`：這些檔案在新舊版本之間有變才重跑（通常是 lockfile）。
- `ifMissing`：這個路徑不存在就重跑（通常是 `node_modules`）。

新建的 worktree、或上一次準備失敗的，所有步驟都會跑。其餘情況只跑 `watch` 或 `ifMissing` 成立的步驟；
兩個都沒寫的步驟只在新建時跑一次。

## 狀態

`status --json` 另外有不分語言的 `state` 欄位（依下表順序是 `idle`、`done`、`busy`、`stale`、`warming`、`missing`）。

| 狀態 | 意思 | `take` 會拿嗎 |
| --- | --- | --- |
| 閒置 | 停在基準分支（detached），沒有變更 | 會 |
| 可回收 | 分支已經合併進基準分支、沒有變更 | 會（分支留著） |
| 使用中 | 有人拿走、或有未提交的變更 | 不會 |
| 可能沒在用 | 拿走超過 `staleAfterHours` 都沒有 commit | 不會，`sweep --stale` 才放回 |
| 準備中 | 正在安裝套件 | 不會 |
| 不見了 | 目錄被刪了 | 不會，`git worktree prune` 清掉 |

「拿走」記在 git 給每個 worktree 的管理目錄（`.git/worktrees/<id>/wtpool.json`），並用
`git worktree lock` 鎖住，避免被 `git worktree remove` / `prune` 誤刪。挑 worktree 時有互斥鎖，
好幾個 session 同時 `take` 也不會拿到同一個。

## 指令

| 指令 | 說明 |
| --- | --- |
| `init [數量]` | 沒有 `.wtpool.json` 就產生一份，再把 worktree 補到指定數量（預設 `size`） |
| `status [--json]` | 列出每個 worktree 的狀態 |
| `take <分支> [--slot wN] [--from <ref>]` | 挑一個閒著的開分支，只把路徑印到 stdout。分支已存在就切過去；只在 origin 有就接著 origin 的做 |
| `release [wN\|分支\|路徑] [--stash]` | 放回：切回基準分支、裝好套件，分支留著。有未提交的變更會拒絕，`--stash` 先收進 `git stash` |
| `add [數量]` | 多開幾個 |
| `remove <wN>` | 移除一個閒置的（整個目錄刪掉） |
| `refresh` | 把閒置的更新到最新的基準分支並裝好套件 |
| `sweep [--stale]` | 放回分支已合併的；`--stale` 連「可能沒在用」的也放回 |
| `which` | 目前目錄在哪個 worktree |
| `hook create\|remove` | 給 Claude Code 的 hook 用，從 stdin 讀 JSON，見下面 |

共用參數：`--no-fetch` 不先 fetch、`--quiet` 不印過程。

結束碼：`0` 成功、`1` 錯誤、`2` 沒有閒著的 worktree。

## 語言

CLI 有英文和繁體中文，用 `WTPOOL_LANG` 切換：

```
WTPOOL_LANG=en wtpool status       # English
WTPOOL_LANG=zh-TW wtpool status    # 繁體中文（寫 zh、zh_TW 也可以）
```

沒設的話跟系統語言：Windows 看系統的顯示語言（Git Bash 一律把 `LANG` 設成 `en_US`，所以不看它），
其他系統看 `LC_ALL` / `LC_MESSAGES` / `LANG`。不是中文就用英文。

想讓 Claude Code 的 hook 也用指定的語言，在 Claude Code 設定的 `env` 加上：

```json
{ "env": { "WTPOOL_LANG": "zh-TW" } }
```

## 跟 Claude Code 的整合

plugin 在 `hooks/hooks.json` 掛了 `WorktreeCreate` 和 `WorktreeRemove` 兩個 command hook：

- **建立**（`wtpool hook create`）：
  - 有 `.wtpool.json`：挑一個閒著的 worktree 開 `wt/<名稱>` 分支並回傳路徑，需要的話先裝好套件。
    池子都在忙時，照 Claude Code 的做法在 `.claude/worktrees/<名稱>` 另開一個（池子不會自己變大）。
  - 沒有 `.wtpool.json`：照 Claude Code 的做法開在 `.claude/worktrees/<名稱>`，分支 `worktree-<名稱>`，
    並照 `.worktreeinclude` 複製檔案（支援一般路徑和根目錄的萬用字元）。
- **移除**（`wtpool hook remove`）：
  - 池子的 worktree 放回池子而不是刪掉：未提交的變更收進 `git stash`，沒有 commit 的 `wt/*` 分支刪掉、
    有 commit 的留著，套件在背景重裝。
  - `.claude/worktrees/` 底下的照 Claude Code 的做法刪掉，未提交的變更一樣先收進 `git stash`，
    分支已經合併才刪。

為什麼不用 plugin 的 hook 模組（`hooks.modules`）：實測 Claude Code 2.1.318 內建的安全模組不讓使用者層級的
hook 模組接手 `WorktreeCreate`，而且 `claude --worktree` 啟動時 worktree 會在 hook 模組載入前就建好，
所以只能用 command hook。代價是 command hook 沒辦法「這次不管、交回 Claude Code」，才需要上面那套照做的邏輯。

注意：subagent 和 workflow 結束時 Claude Code 不會呼叫 `WorktreeRemove`，它們拿走的 worktree 要靠
`wtpool sweep`（分支合併後）或 `wtpool sweep --stale`（沒有 commit、放了很久）放回。

## 開發

```
npm test        # node --test，用暫存目錄建 repo 跟本機的 bare origin 實際跑
claude plugin validate .
```

GitHub Actions 會在 Windows、macOS、Linux 上用 Node 18 和 22 跑測試。
