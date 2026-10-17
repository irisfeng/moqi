# Browse 提供方:Kernel(onkernel.com)

SKILL.md 中共用流程所需的提供方名称:API 密钥 `KERNEL_API_KEY`,密钥链服务
`kernel`。在运行共用的配置文件代码片段之前先运行这一行:

```bash
export PROFILE_ENV=KERNEL_PROFILE PROFILE_SERVICE=kernel-profile
```

## 配置文件

Kernel 的配置文件必须通过 API 预先创建 — 创建浏览器时指定一个
不存在的配置文件会返回 400(这是这里出现 400 的常见原因,而不是 Kernel 故障)。在
首次设置期间,以及每当下面的创建调用返回 400 时,请用密钥链中**已有的**
名称创建配置文件 — 绝不要另起一个新的随机名称,那样会使该凭据成为孤儿:

```bash
curl -fsS -X POST https://api.onkernel.com/profiles \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d "{\"name\":\"$KERNEL_PROFILE\"}" > /dev/null
```

## 创建浏览器

在私信中,带上此人的配置文件:

```bash
CREATE=$(curl -fsS -X POST https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d "{\"stealth\":true,\"headless\":false,\"timeout_seconds\":1800,\"profile\":{\"name\":\"$KERNEL_PROFILE\"}}")
CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('cdp_ws_url',''))")
KERNEL_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))")
LIVE_VIEW=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('browser_live_view_url',''))")
```

在频道或群组中,完全省略配置文件字段(遵循仅限私信的规则)— 绝不要在那里发送
空的或个人的配置文件名称:

```bash
CREATE=$(curl -fsS -X POST https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
  -d '{"stealth":true,"headless":false,"timeout_seconds":1800}')
```

然后按与上面完全相同的方式,从 `$CREATE` 中提取 `CDP_URL` / `KERNEL_SID` / `LIVE_VIEW`。

配置文件是此人自己的浏览状态 — 他们的登录状态在其中跨运行保留,
因此你以这种方式启动的每个浏览器,启动时都已登录到他们所连接的任何站点。
它以只读方式加载:状态通过 Managed Auth 托管流程(见下文)进入其中,绝不来自
你的浏览。(Kernel 也支持 `profile.save_changes: true`,在浏览器 DELETE 时把会话的
cookies 写回 — 不要使用它;并发运行会在写入上产生竞争。)

## 向浏览器提供文件

文件位于 `/home/kernel`:

```bash
curl -fsS -X POST "https://api.onkernel.com/browsers/$KERNEL_SID/fs/upload" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -F "files[]=@/tmp/receipt.jpg;filename=receipt.jpg" -F "dest_dir=/home/kernel"
```

然后按 SKILL.md,用 `BROWSE_FILES="/home/kernel/receipt.jpg"` 运行任务。

## 处理登录屏障的路由

针对此人的配置文件可以使用**完整的** Managed Auth 流程 — 优先使用它(该
会话会为他们之后的所有运行保留;通过实时查看完成的登录只在此
浏览器存续期间有效)。

**只要他们允许,就把此人的登录信息预先保存到 Kernel** — 按 Kernel 自己的指引,这是
可靠的做法。没有关联的凭据时,托管页面会实时探测
登录表单,在某些站点上会卡在 "Discovering login requirements…",直到
链接超时(在 doordash.com 上出现过);有凭据时,Kernel 会跳过探测、自动填写,
并且在会话失效时可以自动重新认证(只有 OTP 仍然需要此人)。

1. **把登录信息放进他们的密钥链**(只有他们拒绝时,才跳到第 3 步的普通托管链接)。先查看
   `GET /v1/keychain/credentials` — 服务/名称与被拦截域名
   匹配的凭据可能已经存在(通过授权使用它;绝不要绑定为其他站点注册的登录信息)。否则
   生成一次性的密钥投递,让密码不经过聊天,并询问他们用哪种方式登录 — 使用 Google SSO 的站点需要
   Google 登录信息,而不是站点密码:
   ```bash
   curl -fsS -X POST "$AGENT_API_URL/v1/keychain/drops" -H "x-agent-capability: $AGENT_API_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"service":"<domain>","fields":[{"key":"EMAIL","secret":false},{"key":"PASSWORD"}],"purpose":"sign in to <domain> in the managed browser"}'
   ```
   交出返回的 `url`,并明确说明同意事项:_填写它会把这份
   登录信息保存到 Kernel(我们的托管浏览器提供方),以便它能替你登录和重新登录_
   — 这种保存正是目的所在,并且需要他们明确同意。兑换完成时会向
   本会话发出唤醒;由于登录仅限私信,此人自己的
   凭据在下一轮即可使用,只需在 `credentials` 中写入它的句柄(这会为该命令设置
   `EMAIL`/`PASSWORD` — 无需走授权流程)。
2. **把凭据保存到 Kernel,然后创建关联了该凭据的连接。**关联
   只在创建连接时有效 — 如果该域名已存在未关联的连接
   (创建时返回 409 并带有 `existing_id`),先 DELETE 它再重新创建。每次保存的名称
   都必须是新的(重复使用会让 Kernel 返回 409 — 绝不会静默覆盖)。用
   Python 根据环境变量构造请求体;密钥绝不进入 shell 源码,临时文件会被删除:
   ```bash
   export CRED_NAME="<domain>-$(python3 -c 'import secrets;print(secrets.token_hex(4))')"
   python3 -c 'import json,os,sys
   domain, name, sso = sys.argv[1], sys.argv[2], os.environ.get("SSO_PROVIDER","")
   body={"name":name,"domain":("accounts.google.com" if sso=="google" else domain),
         **({"sso_provider":sso} if sso else {}),
         "values":{"email":os.environ["EMAIL"],"password":os.environ["PASSWORD"]}}
   print(json.dumps(body))' "<the walled domain>" "$CRED_NAME" > /tmp/cred-body.json
   curl -fsS -X POST https://api.onkernel.com/credentials \
     -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
     --data-binary @/tmp/cred-body.json > /dev/null && rm -f /tmp/cred-body.json
   ```
   (当他们用 Google 登录时,设置 `SSO_PROVIDER=google` — 此时凭据的域名是
   `accounts.google.com`,与 Kernel 文档的规定完全一致。)然后创建连接 — 从 `/tmp/wall-url.txt` 读取
   屏障 URL(在 SKILL.md 中提取;它绝不进入 shell
   源码),并让 Python 构造 JSON。同时把屏障 URL 作为 `login_url` 传入(即使没有凭据
   也会跳过探测):
   ```bash
   python3 -c 'import json,os,sys,urllib.parse
   url=open("/tmp/wall-url.txt").read().strip()
   cred=os.environ.get("CRED_NAME","")
   print(json.dumps({"domain": urllib.parse.urlsplit(url).hostname or "", "profile_name": sys.argv[1],
                     "login_url": url, **({"credential":{"name":cred}} if cred else {})}))' \
     "$KERNEL_PROFILE" > /tmp/conn-body.json
   CONN=$(curl -sS -X POST https://api.onkernel.com/auth/connections \
     -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' --data-binary @/tmp/conn-body.json)


   CONN_ID=$(printf '%s' "$CONN" | python3 -c "import sys,json;j=json.load(sys.stdin);print(j.get('id') or j.get('existing_id',''))")
   ```
3. **启动登录流程**(`record_session: true`,以便卡住的流程可以回看),并把
   托管 URL 交给此人 — 它仅可使用一次,约 30 分钟后过期,绝不要自己打开,并且
   如果他们弄丢了,就重新生成一个:
   ```bash
   curl -sS -X POST "https://api.onkernel.com/auth/connections/$CONN_ID/login" \
     -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
     -d '{"record_session":true}' \
     | python3 -c "import sys,json;print(json.load(sys.stdin).get('hosted_url',''))"
   ```
   有关联凭据时,托管页面会自动填写,通常只会出现 OTP
   这一步;没有凭据时,此人在那里输入自己的登录信息。预期管理:短信/邮件
   OTP 这一步始终需要此人 — 包括会话失效后重新认证时 —
   所以重度依赖双重验证的站点会更好,但不能免手动。避免使用 Kernel 的编程式登录流程
   (轮询 `/auth/connections/:id` 并提交字段):在反复索要同一字段的站点上
   它可能无限循环(在 DoorDash 的邮箱步骤上实际见到过)— 如果你仍然要尝试,
   在同一组字段重新提交约 3 次后就放弃,改用托管链接。
4. 当他们说完成了,通过
   `GET /auth/connections/$CONN_ID` 确认 `status` 是 `AUTHENTICATED`,然后 DELETE 旧浏览器,创建一个全新的
   (它启动时带着已登录的配置文件),并重新运行任务。如果流程反而
   卡在 "Discovering login requirements…",删除该连接,保存一个凭据
   (第 1 步 — 这正是它要防止的故障),然后重新创建关联了凭据的连接。

配置文件只属于他们本人,所以登录真实账号没有问题 — 这正是它的目的。

## 清理

```bash
curl -fsS -X DELETE "https://api.onkernel.com/browsers/$KERNEL_SID" -H "Authorization: Bearer $KERNEL_API_KEY"
```

## API 参考

当某个调用的结果出乎意料时,请阅读这些文档,而不是猜测:

- Managed Auth:https://www.kernel.sh/docs/api-reference/managed-auth/create-auth-connection
  以及 https://www.kernel.sh/docs/api-reference/managed-auth/start-login-flow
- 凭据(预先保存以便自动填写):https://www.kernel.sh/docs/auth/credentials
- 编程式登录流程(SSO 按钮、MFA 选项、流程状态):
  https://www.kernel.sh/docs/auth/programmatic
- 浏览器(创建/删除、配置文件、实时查看、文件系统上传):https://www.kernel.sh/docs/api-reference/browsers
