# orca-graph

Live graph of Orca orchestration: which coordinator dispatched which worker, what each worker is doing, and its last message. Polls the `orca` CLI every 5 seconds by default. Runs on localhost only.

Only **open** agents appear: a worker while its agent session is live, and an agent tab while an agent is running in it. When you exit an agent, its node disappears on the next poll.

## Run

```sh
npm install
npm start          # builds, then serves http://127.0.0.1:4317
```

Development with hot reload: `npm run dev` (API on :4317, UI on Vite's port).
Check the orca parsing without the UI: `npm run snapshot`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | Server port |
| `ORCA_BIN` | `orca` | Path to the orca CLI |

## Colours

| Colour | Status | Comes from |
|---|---|---|
| Green | Done | Latest dispatch `succeeded` |
| Blue | Working | Latest dispatch still running, or coordinator terminal connected |
| Yellow | Needs input | Worker `attention` includes `input` |
| Red | Error | Latest dispatch `failed`, or `attention` includes `failure` |
| Slate | Idle | Agent tab connected but not working (no spinner on its Claude screen) |
| Grey | Offline | Coordinator terminal closed, or a run with no coordinator |

Yellow needs orca's `input` flag **and** an idle worker (no output change for 60s, no command running), because orca can leave that flag set after the worker moves on.

## Using it

- **Click a node** to open its session in the side pane: replies and prompts as a chat thread, with thinking, tool calls and output folded into a closed "steps" row between replies. **Raw output** shows the terminal stream as is. A box at the bottom sends the agent a message.
  - Prompts and replies render Markdown: tables, code blocks (with a Copy button), lists, quotes, inline code and links.
  - For Claude Code tabs the thread comes from Claude's own transcript (`~/.claude/projects/…/<session>.jsonl`), matched to the tab by its latest prompt and reply on screen. That keeps the original Markdown and the full history. If no transcript matches, the pane falls back to what's on the tab's screen, and box-drawn tables there still render as tables.
  - The message box has **Write / Preview** tabs, **Code** (wraps the selection in a code block) and **Table** buttons, and turns cells pasted from a spreadsheet into a Markdown table. Multi-line messages reach the agent as one prompt.
  - Type `/` at the start of a message for the **skills menu**: every `.claude/skills/*/SKILL.md` in the session's folder and each parent folder, plus `~/.claude/skills` (Personal). Sibling folders are not searched. Each row shows the skill's frontmatter description and where it comes from. ↑/↓ to move, Enter or Tab to pick, Esc to close.
  - **Images**: paste, drop, or use the **Image** button (PNG, JPEG, GIF, WebP; up to 6, 10 MB each). The server saves each one to the system temp folder. A Claude tab gets each image as a real attachment: its path is pasted on its own, the way Orca's image paste works, then the text is sent. Other agents and mailbox messages get `[Image: source: <path>]` lines and open the file from there. Sent images show as thumbnails in the thread.
- **Right-click a worker** for cleanup:
  - *Clean up worktree*: stops the worker if it's running (you confirm first), closes its agent session, then `orca worktree rm`. The branch is kept, and orca refuses if the worktree has uncommitted changes.
  - *Clean up worktree and transcripts*: the same, then moves `~/.claude/projects/<worktree path>` to the Trash.
  - Only worktrees under `~/orca/workspaces/` that orca created for that worker, are not a repo root and aren't shared with another session can be cleaned up. Other nodes show why the options are disabled.
- Cleaned-up workers disappear from the graph on the next poll.
- **Orphaned workers** (header button): hover for a preview, click for the cleanup page. An orphan is a worker worktree under `~/orca/workspaces` whose agent session has closed, or a worktree there with no worker record. The page shows branch, last task outcome, last activity and uncommitted changes, with per-row and bulk cleanup. Unfinished dispatches whose agent already exited are fenced with `worker-abandon` before removal.
- **Refresh interval** (header, `every [5] s`): any number of seconds from 1 to 3600, decimals allowed. Applied on Enter or blur, remembered in the browser, and also used by the side pane.

### Sending messages

Messages go to the agent as a prompt (`orca terminal send --enter`). Structured workers (`structworker_*`) are agent sessions, not terminals, so orca refuses terminal commands for them. Their messages go to the worker's orchestration mailbox instead (`orca orchestration send --to dispatch:<id>`). A working worker reads it now; a finished one gets it as a follow-up task. The pane says which route was used.

orca needs a sender (`--from`) for mailbox messages, and the worker's reply goes to that sender:

1. The coordinator that dispatched the worker, while its tab is open. Replies land with the agent that owns the work.
2. Otherwise `ORCA_TERMINAL_HANDLE`, which is set when orca-graph is started inside an Orca terminal tab.

If neither is available, sending fails with an explanation.

The worker itself only sees a notice like "You have 1 orchestration message. Run `orca orchestration check`." In the side pane, each notice is replaced by the messages it announced, read from `orca orchestration inbox`. Yours show as **You · via mailbox**; others show their sender and subject.

### Safety

The server listens on 127.0.0.1 only. Cleanup and send requests must come from a local Host and Origin, be JSON, and carry an `x-orca-graph` header, so other websites can't trigger them. Cleanup acts only on sessions the server itself saw in the last poll, never on paths sent by the browser.

## How the graph is built

- **Nodes** are agent sessions. A worker that takes follow-up tasks is one node; the edge label shows how many tasks it got. Agent tabs outside any orchestration run appear as standalone "Agent session" nodes.
- **Edges** come from `orchestration dispatch-show`: `creator_handle` → `assignee_handle`. Workers that dispatch their own workers nest naturally.
- **Names**: workers use their worktree's display name; coordinators use their terminal title and worktree.
- **Last message**: the newest text block from `orchestration worker-read` for workers, and the terminal preview (with Claude Code's footer removed) for coordinators. Hover a card for the full text.
- Settled dispatches and their messages are cached, so each poll only re-reads active workers.

Liveness is often `unverifiable` in orca, so blue means "last known state: running", not a confirmed live process.
