# Browse 提供方:Anchor(anchorbrowser.io)

SKILL.md 中共用流程所需的提供方名称:API 密钥 `ANCHOR_API_KEY`,密钥链服务
`anchor`。在运行共用的配置文件代码片段之前先运行这一行:

```bash
export PROFILE_ENV=ANCHOR_PROFILE PROFILE_SERVICE=anchor-profile
```

所有调用都通过 `anchor-api-key` 请求头认证(不是 Bearer 令牌)。Anchor 把
API 密钥嵌入了 `cdp_url`,所以 CDP URL 本身就是机密 — 它只作为运行器的
参数传递。

## 配置文件

没有预先创建的步骤:第一个指定某配置文件的会话会注册它,而指定了尚未持久化的配置文件的任务
会话会以空白状态启动而不是报错(已实际验证),因此 SKILL.md 的初始创建只需要进行密钥链注册。只有在创建会话时带上 `persist: true` 并随后将其删除,配置文件才会
捕获浏览器状态 — 所以
要把两种会话形态区分开:

- **任务会话**按名称加载配置文件,**不带** `persist` — 它们启动时已登录到
  配置文件中保存的任何站点,但绝不会写回(并发运行会在写入上产生竞争)。
- **登录会话**(见下文)是唯一使用 `persist: true` 的地方,并且必须
  被删除 — 不能放任其超时 — 登录状态才会落入配置文件。

配置文件没有内置的重新认证:当站点使会话过期时,此人需要再次登录
(或使用下文的身份)。`GET /v1/profiles` 列出它们;
`DELETE /v1/profiles/<name>` 删除其中一个(只能删除来自密钥链的名称,并且只有在
此人要求重置其状态时才可以)。

## 创建浏览器

带上此人的配置文件:

```bash
CREATE=$(curl -fsS -X POST https://api.anchorbrowser.io/v1/sessions \
  -H "anchor-api-key: $ANCHOR_API_KEY" -H 'content-type: application/json' \
  -d "{\"session\":{\"timeout\":{\"max_duration\":30,\"idle_timeout\":10}},\"browser\":{\"profile\":{\"name\":\"$ANCHOR_PROFILE\"}}}")
CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('cdp_url',''))")
ANCHOR_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('id',''))")
LIVE_VIEW=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('live_view_url',''))")
```

超时的单位是分钟(`max_duration` 限制会话总时长,`idle_timeout` 回收未使用的会话)。
对于有严格机器人防护的站点,添加代理和 Anchor 的加固版本 — 两者
都是计费的附加项,所以遇到拦截时再用,不要默认使用:
`"session":{"proxy":{"type":"anchor_proxy","active":true},...}` 加上
`"browser":{"extra_stealth":{"active":true},"captcha_solver":{"active":true}}`
(`extra_stealth` 和 `captcha_solver` 都需要代理)。

## 向浏览器提供文件

上传的文件位于 `/uploads`:

```bash
curl -fsS -X POST "https://api.anchorbrowser.io/v1/sessions/$ANCHOR_SID/uploads" \
  -H "anchor-api-key: $ANCHOR_API_KEY" -F "file=@/tmp/receipt.jpg"
```

然后按 SKILL.md,用 `BROWSE_FILES="/uploads/receipt.jpg"` 运行任务。

## 处理登录屏障的路由

持久的做法是使用**登录会话**:在此人的配置文件上启动一个带
`persist: true` 的全新浏览器,在屏障页面打开,由**他们**通过实时查看来操作。删除它
会把已登录状态写入其配置文件,这样之后每个任务会话启动时都已
登录。**先**删除已停止的任务浏览器,避免两个会话同时占用配置文件:

```bash
curl -fsS -X DELETE "https://api.anchorbrowser.io/v1/sessions/$ANCHOR_SID" -H "anchor-api-key: $ANCHOR_API_KEY"
SIGNIN=$(python3 -c 'import json,sys
url=open("/tmp/wall-url.txt").read().strip()
print(json.dumps({"session":{"initial_url":url,"timeout":{"max_duration":30,"idle_timeout":15}},
                  "browser":{"profile":{"name":sys.argv[1],"persist":True}}}))' "$ANCHOR_PROFILE" \
  | curl -fsS -X POST https://api.anchorbrowser.io/v1/sessions \
      -H "anchor-api-key: $ANCHOR_API_KEY" -H 'content-type: application/json' --data-binary @-)
SIGNIN_SID=$(printf '%s' "$SIGNIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('id',''))")
printf '%s' "$SIGNIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('live_view_url',''))"
```

把打印出的实时查看 URL 交给此人 — 在接下来的几分钟里它就是他们的浏览器:
他们登录、完成任何双重验证,然后说"完成"。接着 DELETE 登录会话(这一步才会
持久化配置文件),创建一个全新的任务浏览器(它启动时已登录),并重新运行
任务:

```bash
curl -fsS -X DELETE "https://api.anchorbrowser.io/v1/sessions/$SIGNIN_SID" -H "anchor-api-key: $ANCHOR_API_KEY"
```

**免手动重新认证(可选,须经此人明确同意)。**仅靠配置文件,在站点使会话过期后
就会失效。如果此人希望不必每次都被打扰就能重新认证,
Anchor 的 Identities 会保存他们的登录信息,并在
每个会话之前自动重新执行认证流程。先查看 `GET /v1/keychain/credentials`,看是否已有
该域名的登录信息(通过授权使用它;绝不要绑定为其他站点注册的登录信息);否则
生成一次性的密钥投递,让密码不经过聊天:

```bash
curl -fsS -X POST "$AGENT_API_URL/v1/keychain/drops" -H "x-agent-capability: $AGENT_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"service":"<domain>","fields":[{"key":"EMAIL","secret":false},{"key":"PASSWORD"}],"purpose":"sign in to <domain> in the managed browser"}'
```

交出返回的 `url`,并明确说明同意事项:_填写它会把这份登录信息保存到
Anchor(我们的托管浏览器提供方),以便它能替你登录和重新登录_ — 这种
保存正是目的所在,并且需要他们明确同意。兑换完成时会向
本会话发出唤醒;在 `credentials` 中写入新凭据的句柄,即可为该命令获得
`EMAIL`/`PASSWORD`。然后用 Python 根据环境变量构造请求体来创建身份
(`POST /v1/identities`,带上 `{"source":"https://<domain>","name":...,"credentials":
[{"type":"username_password","username":...,"password":...}]}`),并把返回的
身份 id 注册到他们的密钥链中(服务 `anchor-identity`,envKey
`ANCHOR_IDENTITY_<DOMAIN_SLUG>`),并附带长期授权,与配置文件的初始创建类似。任务
会话随后在创建请求体中把它与配置文件一起附上:`"identities":[{"id":"<identity-id>"}]`。
`status` 为 `failed` / `agent_failed` 的身份需要再次麻烦此人 —
用 `POST /v1/identities/<id>/re-authenticate-token` 生成重新认证链接,并像任何登录链接一样
交给他们。在你第一次创建
身份之前先阅读
https://docs.anchorbrowser.io/essentials/authenticated-applications — 认证流程的字段(OTP、TOTP、SSO)都在那里,
瞎猜它们会保存下一个无效的登录。

## 清理

```bash
curl -fsS -X DELETE "https://api.anchorbrowser.io/v1/sessions/$ANCHOR_SID" -H "anchor-api-key: $ANCHOR_API_KEY"
```

## API 参考

当某个调用的结果出乎意料时,请阅读这些文档,而不是猜测:

- 会话(创建/删除、配置文件、代理/隐身、实时查看、上传):
  https://docs.anchorbrowser.io/api-reference/browser-sessions/start-browser-session
- 配置文件与身份(何时使用哪种认证模型):
  https://docs.anchorbrowser.io/essentials/managed-authentication
- 身份与应用(保存的登录信息、自动重新认证、重新认证链接):
  https://docs.anchorbrowser.io/essentials/authenticated-applications
- 完整文档索引:https://docs.anchorbrowser.io/llms.txt
