---
name: interactive-login
description: 通过浏览器/设备码流程让 CLI 登录(aws sso、gh、glab、gcloud 等),并把结果保存到密钥链,以便之后的命令通过 execute.credentials 请求使用。
---

# 交互式登录

没有任何东西会替你捕获登录。每次登录都在全新的临时主目录中运行,并用本技能附带的脚本
保存到密钥链。绝不要对真实的
`$HOME` 执行登录,也绝不要把 `$HOME` 中已有的令牌或配置当作可用的登录:只有
密钥链句柄才算。技能读取、登录
和保存登录的命令都使用同一个明确的 `sandbox_id`,这样临时主目录和保存脚本都在同一台计算机上。

1. 新建一个目录,用 `execute(background:true)` 启动登录,并把每个配置
   位置都指向该目录。先复制进 CLI 需要的任何配置(对 AWS 而言,是 `.aws/config` 中的
   `[profile …]`/`[sso-session …]` 块);该
   目录下的所有内容都会成为保存的登录。

   ```bash
   d=$(mktemp -d) && echo "$d"
   in_d() { env HOME="$d" XDG_CONFIG_HOME="$d/.config" XDG_DATA_HOME="$d/.local/share" XDG_STATE_HOME="$d/.local/state" XDG_CACHE_HOME="$d/.cache" "$@"; }
   in_d aws sso login --profile work --use-device-code --no-browser
   in_d gh auth login --hostname github.com --git-protocol https --web
   in_d glab auth login --hostname gitlab.com --web
   in_d gcloud auth login --no-launch-browser
   ```

   使用 CLI 的设备码模式(AWS 需要 `--use-device-code`);浏览器流程只有
   在同一台机器上才能完成。

2. 从任务输出中转交验证 URL 和验证码。用
   `background` 动作 `send_input` 回答任何提示。配合返回的
   `process_id` 使用它的 `watch` 或 `poll` 动作;在对方还在批准期间,绝不要停止该任务。

3. 任务成功退出后,使用技能读取时所报告的绝对目录下的脚本
   保存该目录:

   ```bash
   node <skill dir>/scripts/save-login.mjs aws "$d" --label "work (123456789012)"
   ```

   该脚本只上传该目录下的文件,删除该目录,并
   打印凭据句柄。它也会删除不含可用登录的目录。
   绝不要自己删除该目录;如果保存失败,再次运行该脚本。
   再次保存同一个服务会就地替换该条目:它的 id、句柄、所有者和
   授权都保持不变。

4. 使用该登录的唯一方式,是在 `execute`(包括 `background:true`)的 `credentials` 中写明句柄,包括用来检查它是否可用时。这些文件会暂存在该命令或任务专用的私有主目录中,
   CLI 写入的刷新内容会在其结束时保存回去。

绝不要打印令牌文件,也不要把其内容粘贴到会话中。如果登录失败
或过期,用新的目录从第 1 步重新开始。
