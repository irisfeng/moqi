---
name: github-gitlab
description: 通过智能体计算机上常驻的 gh/glab/git 认证,操作 GitHub 和 GitLab 仓库。
requiredCapabilities:
  - egress:github.com
  - egress:api.github.com
  - egress:gitlab.com
---

# GitHub / GitLab

当用户要求查看仓库、issue、拉取请求、合并
请求、代码历史、分支,或要在托管仓库中做小的代码改动时,使用本技能。

## 审慎选择账号

根据当前的凭据清单,选择一个已获准用于本次会话、且
符合用户意图的账号。用 `execute` 并带上明确的 `sandbox_id` 运行命令;
在检出、编辑、检查和推送的全过程中使用同一个 ID。个人账号和共享账号都是有效的选择;
当其中一个失败时,另一个都不是自动的回退方案。如果在
写入之前不清楚应使用哪个账号,先询问。不要仅仅因为计算机上存在某个登录,就推断出有权限。

- **个人登录:**使用已获授权的 `gh`、`glab` 或 Git 登录。检查当前生效的
  提供方账号(例如 `gh api user --jq .login`)以及 Git 传输层的认证
  配置;仅凭 CLI 的 API 身份,并不能证明 Git 会使用哪个账号。
- **共享的组织凭据:**如果在提示中列出,选择它的 slug,并使用
  `use-shared-credential` 技能中由核心托管的智能 HTTP 远程地址。这会使用
  配置好的共享账号,即使个人 OAuth 连接器处于活动状态也是如此。
  它的名称是管理员设定的标签,不是经过验证的上游用户名。
- **已连接的应用:**只使用它所公开的能力。API 访问本身并不
  意味着可以使用原生 Git 传输,也不会配置 CLI 当前生效的登录。

对于已有的检出目录,检查远程地址以及适用的凭据助手、SSH、
代理和 HTTP 请求头配置。复用的检出目录
可能仍然选用之前的账号。提交的作者元数据与传输层
身份是两回事。在写入之前先弄清未知的身份;不要通过推送来探测访问权限。

## 登录

只有在收到明确的认证拒绝之后,才使用原生登录。TLS 超时、
连接被重置、速率限制或 GitHub 服务器错误,都不能证明已登出
或权限已过期。不要为了修复传输问题而消耗另一个凭据授权。

对于已确认缺失或已过期的 GitHub 或 GitLab 登录,请遵循
`interactive-login` 技能:它会在临时
主目录中以后台任务运行 `gh auth login` / `glab auth login`,转交验证码和 URL,并把登录信息保存到密钥链,
以便之后的命令通过 `execute.credentials` 使用它。

## 只读工作

检查认证并查看仓库状态:

```bash
gh auth status
gh repo view OWNER/REPO --json name,description,url,defaultBranchRef
gh issue list --repo OWNER/REPO --state open --limit 20
gh pr list --repo OWNER/REPO --state open --limit 20
```

对于 GitLab:

```bash
glab auth status
glab repo view GROUP/PROJECT
glab issue list --repo GROUP/PROJECT
glab mr list --repo GROUP/PROJECT
```

用 `git log`、`git show` 和 `git diff` 来总结代码变更。引用提交
哈希、PR/MR 编号和链接。

## 检出与编辑

只克隆或拉取用户要求的那个仓库:

```bash
gh repo clone OWNER/REPO repo
cd repo
git checkout -b codex/small-change
```

保持改动范围收敛。运行该仓库的测试。如果要求推送或创建 PR/MR,
先准备好分支和摘要。

## 写入需要审批

推送分支、创建 PR/MR、合并、关闭 issue、编辑标签、更改
仓库设置、发布版本或修改工作流,都属于写入。运行
写入命令之前,先请求审批。

获得审批后:

```bash
git push -u origin codex/small-change
gh pr create --repo OWNER/REPO --title "..." --body-file pr.md
```

对于 GitLab:

```bash
git push -u origin codex/small-change
glab mr create --repo GROUP/PROJECT --title "..." --description-file mr.md
```

汇报最终的 URL,并留下足够的上下文以便审阅。

## 等待 GitHub CI

使用随附的辅助脚本,而不是单独的 `gh pr checks --watch` 或手写的
shell 循环。用技能读取时报告的绝对目录替换
`<skill dir>`。它是一个阻塞式的监视进程,而不是重复的智能体轮次:

```bash
node "<skill dir>/scripts/watch-ci.mjs" --repo OWNER/REPO --pr NUMBER --head REVIEWED_HEAD_SHA
```

在审阅之前,通过 `gh pr view NUMBER --repo OWNER/REPO --json headRefOid`
获取完整的 head SHA。监视脚本和最终的合并关卡都使用同一个 SHA。用 `execute`,
带上所选的 `sandbox_id` 和 `background:true` 启动监视脚本,然后
用 `background` 动作 `watch` 及其返回的 `process_id` 订阅。每个 PR 只保留一个
监视脚本。把进程的存活时间设置得比辅助脚本的 30 分钟期限更长;
如需不同的有限期限,使用 `--timeout-ms`。只使用已获准用于
该后台进程的凭据;前台的实时授权并不授权后台工作。

辅助脚本在内部轮询 GitHub,并输出 JSON 状态记录。它只对
已识别的暂时性传输/服务器错误做有限退避的重试。待定的检查
保持待定。真正的 CI 失败、认证/授权失败、head 变化、
未知错误、重试耗尽以及超过期限,都会以非零状态码停止。
明确的 API 速率限制会以 `rate_limited` 停止,而不是认证错误。
空的检查集合、被跳过的检查和被取消的检查都不算成功的证据。
不要仅凭退出码就判断"检查已结束":要读取状态记录。
不要掩盖非零退出码,也不要在它之后打印成功标记。保留 `set -e`。

成功表示针对预期 head 所观察到的检查已通过,并不是允许
合并。合并之前立即重新读取检查结果和审阅讨论串。等待该确切 head 上的异步
审阅者;解决发现的问题,并获取一次全新上下文的对抗式
审阅。在任何推送或 head 变化之后,丢弃旧的成功/审阅证据并重复整个流程。
只有所有关卡都通过时才合并,并使用 GitHub 的原子性 head 保护:

```bash
gh pr merge NUMBER --repo OWNER/REPO --squash --match-head-commit REVIEWED_HEAD_SHA
```

绝不要使用自动合并,也不要绕过仓库的关卡。该辅助脚本不会重试 GitLab
命令,也不会改变它们的认证行为。
