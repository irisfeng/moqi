# Browse 提供方:Browserbase(browserbase.com)

SKILL.md 中共用流程所需的提供方名称:API 密钥 `BROWSERBASE_API_KEY`,密钥链
服务 `browserbase`。在运行共用的配置文件代码片段之前先运行这一行:

```bash
export PROFILE_ENV=BROWSERBASE_CONTEXT PROFILE_SERVICE=browserbase-context
```

所有调用都通过 `X-BB-API-Key` 请求头认证。`projectId` 在所有地方都是可选的
— 它会根据 API 密钥推断出来。`connectUrl` 是带令牌的 websocket — 与任何 CDP URL 一样,
是机密。

## 配置文件(Browserbase 称之为 Contexts)

这里的配置文件值是由提供方分配的 **context id**,不是你自己生成的名称:在
SKILL.md 的首次初始创建中,用创建 context 返回的 id **替换**生成的 `$PROFILE`,
然后原样继续进行密钥链注册:

```bash
PROFILE=$(curl -fsS -X POST https://api.browserbase.com/v1/contexts \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' -d '{}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
export "$PROFILE_ENV"="$PROFILE"
```

context 保存已登录状态(cookies、localStorage 等)。三条规则
让登录状态在多次运行之间保持有效 — 违反任何一条,此人都要重新登录:

- **只有登录会话才写入。**任务会话指定 context 时**不带** `persist`
  (默认 false — 只读加载);只有下文专用的登录会话才设置
  `persist: true`,并且它的状态在会话被**释放**时才写入 context,而不是
  在运行期间。
- **每个 context 同一时间只有一个会话。**Browserbase 警告,同一个
  context 上的并发会话可能导致站点强制登出 — 在同一个 context 上启动另一个会话之前,
  务必先释放正在运行的会话。
- **给写回留一点时间。**释放 `persist: true` 会话之后,等待几秒再在该 context 上
  启动下一个会话 — 持久化是异步的。

没有免手动重新认证这一档:当站点使 cookies 过期时,此人需要
通过下文同样的实时查看流程再次登录。

## 创建浏览器

`keepAlive` 在这里处处重要:没有它,会话会在 CDP 客户端
断开连接时立即终止,因此运行器重试或下文的登录交接会发现浏览器已经失效。
(它需要 Hobby 套餐或更高。)在私信中,带上此人的 context:

```bash
CREATE=$(curl -fsS -X POST https://api.browserbase.com/v1/sessions \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d "{\"keepAlive\":true,\"timeout\":1800,\"browserSettings\":{\"context\":{\"id\":\"$BROWSERBASE_CONTEXT\"}}}")
CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('connectUrl',''))")
BB_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
LIVE_VIEW=$(curl -fsS "https://api.browserbase.com/v1/sessions/$BB_SID/debug" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('debuggerFullscreenUrl',''))")
```

实时查看 URL 是按标签页区分的:顶层的 `debuggerFullscreenUrl` 属于第一个标签页,
一旦任务打开更多标签页,它就会过期。之后每当你交出实时查看链接时,
都要在交接时重新获取 `/v1/sessions/$BB_SID/debug`,并从
`pages[]` 中选出正确的条目(每个条目都有自己的 `debuggerFullscreenUrl`、`url` 和 `title`)。

在频道或群组中,完全省略 `browserSettings.context`(遵循仅限私信的规则):

```bash
CREATE=$(curl -fsS -X POST https://api.browserbase.com/v1/sessions \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d '{"keepAlive":true,"timeout":1800}')
```

然后按与上面完全相同的方式提取 `CDP_URL` / `BB_SID` / `LIVE_VIEW`。

超时的单位是秒(60–21600);验证码求解默认开启。对于有
严格机器人防护的站点,添加顶层的 `"proxies":true` 和
`"browserSettings":{"advancedStealth":true}`(Scale 套餐功能)— 这些是计费的附加项,
遇到拦截时再用,不要默认使用。

## 向浏览器提供文件

通过 Session Uploads API 上传;文件位于 `/tmp/.uploads/<name>`:

```bash
curl -fsS -X POST "https://api.browserbase.com/v1/sessions/$BB_SID/uploads" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -F "file=@/tmp/receipt.jpg"
```

然后按 SKILL.md,用 `BROWSE_FILES="/tmp/.uploads/receipt.jpg"` 运行任务。

## 处理登录屏障的路由

在这个流程中,Browserbase 没有托管的登录页面或凭据存储 — 由此人
**自己**通过实时查看登录,之后 context 会让他们保持登录状态。
先释放旧的任务浏览器,并给释放留一点时间:它是异步的,调用返回时 keepAlive
会话仍在运行,而同一个 context 上有两个会话
正是强制登出的情形:

```bash
curl -fsS -X POST "https://api.browserbase.com/v1/sessions/$BB_SID" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"REQUEST_RELEASE"}'
sleep 5
```

创建登录会话 — 这是唯一出现 `persist: true` 的地方:

```bash
SIGNIN=$(curl -fsS -X POST https://api.browserbase.com/v1/sessions \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d "{\"keepAlive\":true,\"timeout\":1800,\"browserSettings\":{\"context\":{\"id\":\"$BROWSERBASE_CONTEXT\",\"persist\":true}}}")
SIGNIN_SID=$(printf '%s' "$SIGNIN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
SIGNIN_CDP=$(printf '%s' "$SIGNIN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('connectUrl',''))")
```

它打开时是空白页,所以要把它引导到屏障页面,然后获取实时查看链接
(`keepAlive` 使会话在导航脚本断开连接后仍能存活 — 没有它,
此人打开的将是一个已失效的实时查看):

```bash
cat > /tmp/bb-nav.py <<'PY'
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(os.environ["SIGNIN_CDP"])



    ctx = b.contexts[0]
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(open("/tmp/wall-url.txt").read().strip(), timeout=60000)
    b.close()
PY
SIGNIN_CDP="$SIGNIN_CDP" /opt/browser-engine/venv/bin/python /tmp/bb-nav.py
curl -fsS "https://api.browserbase.com/v1/sessions/$SIGNIN_SID/debug" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('debuggerFullscreenUrl',''))"
```

把打印出的 URL 交给他们 — 它就是他们的浏览器:他们登录、完成任何双重验证,然后说
"完成"。预期管理:context 持久化的是会话 cookies,它无法重新回答
质询 — 每次访问都要重新验证的站点(短信/邮件 OTP)下次
仍然需要此人参与。然后**释放**登录会话(这一步才会写入 context),给
写回留一点时间,创建一个全新的任务浏览器(它启动时已登录),并重新运行
任务:

```bash
curl -fsS -X POST "https://api.browserbase.com/v1/sessions/$SIGNIN_SID" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"REQUEST_RELEASE"}'
sleep 5
```

**实时**任务浏览器上的会话中途验证检查不需要走 persist 的那一套 — 把
**新的**实时查看链接交给此人(重新获取 `/debug`,并按上文关于按标签页区分的说明,
从 `pages[]` 中选出被质询的标签页),等待其完成,然后在同一个
浏览器上重新运行任务。

## 清理

会话按分钟计费,而 `keepAlive` 会话在断开连接后仍会继续存在 — 务必释放:

```bash
curl -fsS -X POST "https://api.browserbase.com/v1/sessions/$BB_SID" \
  -H "X-BB-API-Key: $BROWSERBASE_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"REQUEST_RELEASE"}'
```

## API 参考

当某个调用的结果出乎意料时,请阅读这些文档,而不是猜测:

- 会话(创建/更新/释放、keepAlive、超时、代理):https://docs.browserbase.com/reference/api/create-a-session
- Contexts(持久化语义、单会话规则):https://docs.browserbase.com/features/contexts
- 实时查看(调试 URL、人工接管):https://docs.browserbase.com/features/session-live-view
- 上传:https://docs.browserbase.com/features/uploads
