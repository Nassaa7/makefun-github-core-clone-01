# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Nassaa7/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Nassaa7/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node.js process, standard library only, with no git binary and no outside services. It serves four surfaces backed by one in-memory store: git smart HTTP (protocol v2 advertisement, ls-refs and fetch, v0 fallback, and fast-forward-only receive-pack), REST v3 (repositories, branches, refs, commits, contents, labels, issues, and pull requests with squash merges), GraphQL (viewer, repository, node, introspection, cursor-paginated issues and pull requests, and issue/PR/comment mutations), and MCP over Streamable HTTP (six tools: create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request). Behavior is deterministic: fixed timestamps and no randomness, so replays leave identical state.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jy7g3kr7&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
