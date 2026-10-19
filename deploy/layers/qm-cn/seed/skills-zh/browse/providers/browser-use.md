# Browse 提供方:Browser Use Cloud(browser-use.com)

SKILL.md 中共用流程所需的提供方名称:API 密钥 `BROWSER_USE_API_KEY`,密钥链
服务 `browser-use`。在运行共用的配置文件代码片段之前先运行这一行:

```bash
export PROFILE_ENV=BROWSER_USE_PROFILE PROFILE_SERVICE=browser-use-profile
```

所有调用都发往 `https://api.browser-use.com/api/v4`,并通过 `X-Browser-Use-API-Key`
请求头认证(不带 `Bearer` 前缀)。额度、并发数以及该密钥所属的项目,可通过
`GET https://api.browser-use.com/api/v2/billing/account` 查看 — 当创建返回 402(额度用完)或 429(活跃浏览器过多)时,先查看它。

每个浏览器都运行 Browser Use 加固过的 Chromium,默认开启隐身和反指纹识别,
并配有美国住宅代理和自动验证码求解 — 无需设置任何隐身参数。

## 配置文件

这里的配置文件值是由提供方分配的**配置文件 id**(一个 UUID),而不是你自己
生成的名称:在 SKILL.md 的首次引导中,用创建配置文件得到的 id **替换**生成的 `$PROFILE`,然后照常继续进行密钥链注册:

```bash
PROFILE=$(curl -fsS -X POST https://api.browser-use.com/api/v4/profiles \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"qm"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
[ -n "$PROFILE" ] || { echo "profile create returned no id" >&2; exit 1; }
export "$PROFILE_ENV"="$PROFILE"
```

配置文件保存 cookie 和本地存储。让登录状态保持有效的规则:

- **状态在浏览器停止时写入**,可以是通过"清理"中的停止调用,也可以是达到其 `timeout`。运行期间不会保存任何内容,
  而且关闭 CDP(或运行器退出)并不会停止浏览器。请显式停止,不要等它超时。
- **同一个配置文件同一时间只能有一个浏览器。**在同一配置文件上启动另一个浏览器之前,先停止正在运行的那个;
  同一个登录并行多个会话容易导致被强制退出登录。
- **给写回留一点时间。**停止之后,等待约 10 秒,再在该配置文件上启动下一个浏览器。
- **使用默认的浏览器上下文。**全新的无痕上下文(`new_context()`)
  不会继承配置文件的 cookie。

`GET /profiles/$BROWSER_USE_PROFILE` 会返回 `cookieDomains` — 这是检查配置文件保存了哪些站点状态的最快方法。

## 创建浏览器

带上此人的配置文件。首先确认此人的配置文件上没有仍在运行的浏览器 — 状态只在浏览器停止时写入,所以遗留的运行中浏览器会一直占着它。v4 的列表不会说明会话使用的是哪个配置文件,因此本文档创建的每个浏览器都会在 `metadata` 中打上其配置文件 id 的标记,检查时只会停止带有标记且属于该配置文件的持有者。没有标记的活跃浏览器,不应不加查看就去停止:在共享密钥上,它是别人的任务(不要动它,并说明情况);在此人自己的密钥上,它只可能是他们较早的浏览器 — 创建之前手动停止它。停止持有者本身也就是保存它,所以不会丢失任何内容。这个检查不是锁 — 同一时刻的两次创建可能都通过检查 — 所以一个人的配置文件上,一次只保持一个 browse 运行:

```bash
ACTIVE=$(curl -fsS "https://api.browser-use.com/api/v4/browsers?filterBy=active" \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" \
  | python3 -c "import sys,json,os;p=os.environ['BROWSER_USE_PROFILE'];print(' '.join(b['id'] for b in json.load(sys.stdin)['items'] if b.get('status')=='active' and (b.get('metadata') or {}).get('profileId')==p))")
if [ -n "$ACTIVE" ]; then
  for B in $ACTIVE; do
    curl -fsS -X PATCH "https://api.browser-use.com/api/v4/browsers/$B" \
      -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
      -d '{"action":"stop"}' > /dev/null
  done
  sleep 10
fi
```

然后创建(`metadata` 标记正是上面的检查所匹配的):

```bash
CREATE=$(curl -fsS -X POST https://api.browser-use.com/api/v4/browsers \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
  -d "{\"profileId\":\"$BROWSER_USE_PROFILE\",\"timeout\":30,\"metadata\":{\"profileId\":\"$BROWSER_USE_PROFILE\"}}")
BU_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
CDP_BASE=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['cdpUrl'].rstrip('/'))")
CDP_URL=$(curl -fsS "$CDP_BASE/json/version" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['webSocketDebuggerUrl'])")
LIVE_VIEW=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['liveUrl'])")
```

`cdpUrl` 是一个 `https://…cdp.browser-use.com` 形式的基础地址;`/json/version` 这一跳会把它转成运行器驱动的 websocket。它和 `LIVE_VIEW` 都属于持有者凭证 — 任何持有其中之一的人都能控制浏览器。

`timeout` 的单位是分钟(1–240)。`proxyCountryCode` 默认为 `"us"`;传入其他 ISO 代码可更改,传入 `null` 则去掉代理。浏览器按分钟计费,停止时按比例退还。

## 向浏览器提供文件

这里无法访问浏览器的文件系统,而且 `file://` 页面被阻止,所以运行器的 `available_file_paths` 路线不适用。改为把文件直接交给页面:打开带文件输入框的页面,然后通过 CDP 注入字节。将 `SELECTOR` 指向目标输入框:

```bash
cat > /tmp/bu-attach.mjs <<'JS'
import fs from "fs";
const [, , wsUrl, filePath, selector] = process.argv;
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, m => (m.error ? reject(new Error(m.error.message)) : resolve(m))); ws.send(JSON.stringify({ id: i, ...(sessionId ? { sessionId } : {}), method, params })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
ws.onclose = () => { for (const r of pending.values()) r({ error: { message: "cdp socket closed" } }); pending.clear(); };
await new Promise(r => ws.onopen = r);
const { targetInfos } = (await send("Target.getTargets")).result;
const page = targetInfos.find(t => t.type === "page");
if (!page) throw new Error("no page target on the browser");
const { sessionId } = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).result;
const b64 = fs.readFileSync(filePath).toString("base64");
const name = filePath.split("/").pop();
const expression = `(()=>{const s=atob(${JSON.stringify(b64)});const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);
const dt=new DataTransfer();dt.items.add(new File([u],${JSON.stringify(name)}));const el=document.querySelector(${JSON.stringify(selector)});
if(!el)throw new Error("no element matches the selector");el.files=dt.files;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return el.files[0].size})()`;
const { result } = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
if (result.exceptionDetails) throw new Error(`page rejected the injection: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
console.log(JSON.stringify(result.result));
ws.close();
JS
node /tmp/bu-attach.mjs "$CDP_URL" /tmp/receipt.jpg "$SELECTOR"
```

当协议调用失败或页面抛出错误(选择器没有匹配到任何元素、页面被阻止)时,脚本会以非零状态退出 — 把这视为附加失败:读取错误并修复,不要假定文件已附加就重新运行任务。然后运行任务,并告诉智能体文件已经附加。文件要保持较小(这会内联字节);只通过原生选择器对话框读取文件的网站看不到它。

## 处理登录屏障的路由

此人通过实时查看**自己**登录;之后配置文件会让他们保持登录。复用任务浏览器 — 它已经带着配置文件 — 并用 SKILL.md 中共享的 `browse-nav.py` 把它引导到屏障页面:

```bash
CDP_URL="$CDP_URL" /opt/browser-engine/venv/bin/python /tmp/browse-nav.py
printf '%s\n' "$LIVE_VIEW"
```

把 `$LIVE_VIEW` 交给他们:他们登录、完成任何双重验证,然后说"完成"。确认页面现在显示他们已登录,然后停止浏览器(这正是写入配置文件的动作),等待约 10 秒,在同一配置文件上创建新的浏览器,并重新运行任务。配置文件只会重放 cookie,无法应答质询,所以每次访问都要重新验证的网站,下次仍需要此人参与。

会话中途的验证检查无需停止 — SKILL.md 中的实时查看规则已涵盖。

## 清理

务必停止浏览器。运行器会让它保持运行,否则它会一直计费到超时,而停止才是保存配置文件的动作:

```bash
curl -fsS -X PATCH "https://api.browser-use.com/api/v4/browsers/$BU_SID" \
  -H "X-Browser-Use-API-Key: $BROWSER_USE_API_KEY" -H 'content-type: application/json' \
  -d '{"action":"stop"}'
```

## API 参考

当某个调用的结果出乎意料时,请阅读这些文档,而不是猜测(完整合集为
https://docs.browser-use.com/.well-known/llms-full.txt):

- 浏览器(创建、停止、超时、代理):https://docs.browser-use.com/cloud/api-v4/browsers/create-browser-session.md
- 配置文件:https://docs.browser-use.com/cloud/guides/authentication.md
- CDP 控制:https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium.md
- 实时查看:https://docs.browser-use.com/cloud/browser/live-preview.md
- 隐身、代理、验证码:https://docs.browser-use.com/cloud/browser/stealth.md
