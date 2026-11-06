---
name: wtpool
description: 在有 .wtpool.json 的 git repo 裡要改程式（新功能、修 bug、任何要開分支的工作）之前使用：從預熱好的 worktree 池拿一個 worktree 開分支，不要在主 checkout 直接改，也不要自己 git worktree add。分支做完要放回、想看池子狀態、池子都在忙，或使用者想替 repo 設定 worktree 池時也用這個。
---

# wtpool：預熱好的 worktree 池

repo 根目錄有 `.wtpool.json` 時，這個 repo 有一組固定的 worktree（池子）。它們平常停在基準分支，
node_modules、編譯產物都留著；接需求時挑一個閒著的開分支，做完放回去，下一個需求就不用重裝、重編。

CLI 是 `node "${CLAUDE_PLUGIN_ROOT}/cli/wtpool.mjs"`，下面簡寫成 `wtpool`，執行時要寫完整。
在 repo 裡任何地方（包括池子裡的 worktree）執行都可以。

## 開始一個需求

1. `wtpool which`：已經在池子的某個 worktree，而且就是這個需求的分支，就繼續用，不要再拿。
2. `wtpool take <分支>`：挑一個閒著的 worktree 開分支（分支已存在就切過去），stdout 只有路徑。
   - 分支名照 repo 的慣例取（看 `git branch -a` 或最近的分支名，例如 `feature/xxx`）。
   - 之後所有讀檔、改檔、跑指令都在那個路徑裡做：Bash 先 `cd` 過去，檔案用絕對路徑。
   - 新分支從 `.wtpool.json` 的 `base` 開，不設 upstream；第一次 push 用 `git push -u origin <分支>`。
3. 結束碼 2 表示都在忙：把 `wtpool status` 的結果給使用者看，**先問要不要多開一個**，同意才跑
   `wtpool add` 再 `take`。不要自己決定多開，每多一個就多一份 node_modules 和編譯產物。
4. 結束碼 1 是錯誤，照訊息處理（例如分支名稱不合法、分支已經在別的 worktree 用著）。

用 `EnterWorktree`、`claude --worktree` 或 subagent 的 `isolation: worktree` 也會自動從池子拿
（這個 plugin 的 hook 接手了）。這時分支叫 `wt/<名稱>`，要改成正式名稱就 `git branch -m <新名稱>`。
池子都在忙時，hook 會照 Claude Code 平常的做法在 `.claude/worktrees/<名稱>` 另開一個，不用處理。
subagent 用完的池子 worktree 不會自動放回，分支合併後記得 `wtpool sweep`。

## 做完

- 分支合併以後 `wtpool release <wN>`（人在那個 worktree 裡就直接 `wtpool release`）：切回基準分支、
  重新裝好套件，分支本身留著。
- 有未提交的變更會被拒絕。先 commit；確定不要了才加 `--stash`（變更收進 `git stash`）。
- `wtpool sweep` 一次放回所有分支已合併的；`--stale` 連拿走很久都沒 commit 的也放回。

## 其他指令

- `wtpool status`：每個 worktree 的狀態（閒置、使用中、可回收、準備中…）；`--json` 給程式讀。
- `wtpool refresh`：把閒置的 worktree 更新到最新的基準分支，並裝好套件。
- `wtpool remove <wN>`：移除一個閒置的 worktree（整個目錄刪掉）。只在使用者要縮小池子時用。

## 不要做

- 不要刪池子裡 worktree 的目錄，也不要對它們 `git worktree remove`；不用了就 `release`。
- 不要在池子的 worktree 裡跑 `git clean -x` 或刪 node_modules、target 這些快取，留著它們就是池子的用意。

## 替 repo 設定池子（使用者要求時才做）

`wtpool init` 會產生 `.wtpool.json`（猜好基準分支和安裝指令），再建立 worktree。產生後把內容給使用者確認，
尤其是 `base` 和 `setup`，由使用者決定要不要 commit。欄位：

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `base` | origin 的預設分支 | 新分支從這裡開，放回時也切回這裡，例如 `origin/dev` |
| `dir` | `../{repo}-worktrees` | worktree 放哪，相對於 repo 根目錄 |
| `name` | `w{n}` | worktree 的資料夾名稱 |
| `size` | `2` | `init` 預設建立幾個 |
| `setup` | `[]` | 準備步驟：`run` 指令、`cwd` 在哪個子目錄跑、`watch` 這些檔案變了才重跑、`ifMissing` 這個路徑不在就重跑 |
| `copy` | `[]` | 從主 checkout 複製過去的檔案（要是被 gitignore 的，例如 `.env`） |
| `hookBranch` | `wt/{name}` | Claude Code 內建 worktree 拿池子時用的分支名稱 |
| `staleAfterHours` | `24` | 拿走多久沒 commit 算「可能沒在用」 |
