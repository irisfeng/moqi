# Browse 提供方:Kernel(onkernel.com)

SKILL.md 中共用流程所需的提供方名称:API 密钥 `KERNEL_API_KEY`,密钥链服务
`kernel`。在运行共用的配置文件代码片段之前先运行这一行:

```bash
export PROFILE_ENV=KERNEL_PROFILE PROFILE_SERVICE=kernel-profile
```

在 `credentials` 中指明三个句柄:Kernel 密钥(见下文"使用哪个密钥")、
此人的 `KERNEL_PROFILE`,以及他们的 `KERNEL_PROXY_ID`(见"此人的静态 IP")。

## 使用哪个密钥

使用下面第一个存在的:

1. **此人自己的密钥**:你的密钥链清单中属于他们的 `KERNEL_API_KEY` 句柄。在 `credentials` 中指明它。
2. **作为环境变量交付的组织密钥**:你的 shell 中已设置 `KERNEL_API_KEY`。
3. **组织共享的 Kernel 凭据**:凭据清单中的一行 `service_kernel`(代理,主机 `api.onkernel.com`)。在 `credentials` 中指明 `service_kernel`。
   你永远看不到这个密钥。QM 通过它的凭据代理把密钥加到你发出的每个请求上
   (参见 use-shared-credential 技能),所以 `KERNEL_API_KEY` 保持未设置。

本文档中的每个 Kernel API 调用都通过 `kapi METHOD PATH [JSON-BODY]` 发出,它会
选择正确的路由,打印响应正文,并且在任何错误时以非零状态退出,
状态和正文输出到 stderr。每个 shell 定义一次:

```bash
kapi() {
  if [ -n "${KERNEL_API_KEY:-}" ]; then
    if [ -n "${3:-}" ]; then
      curl -fsS -X "$1" "https://api.onkernel.com$2" -H "Authorization: Bearer $KERNEL_API_KEY" \
        -H 'content-type: application/json' -d "$3"
    else
      curl -fsS -X "$1" "https://api.onkernel.com$2" -H "Authorization: Bearer $KERNEL_API_KEY"
    fi
  else
    python3 - "$1" "$2" "${3:-}" <<'PY'
import json, os, sys, urllib.error, urllib.request
method, path, body = sys.argv[1:4]
req = {"credential": "kernel", "method": method, "url": "https://api.onkernel.com" + path}
if body:
    req["headers"] = {"content-type": "application/json"}
    req["body"] = body
r = urllib.request.Request(os.environ["AGENT_API_URL"] + "/v1/credentials/broker",
    data=json.dumps(req).encode(), method="POST",
    headers={"x-agent-capability": os.environ["AGENT_CREDENTIAL_TOKEN"], "content-type": "application/json"})
try:
    env = json.load(urllib.request.urlopen(r))
except urllib.error.HTTPError as e:
    sys.stderr.write(f"broker {e.code}: {e.read().decode()[:500]}\n"); sys.exit(1)
if not 200 <= env.get("status", 0) < 300:
    sys.stderr.write(f"kernel {env.get('status')}: {(env.get('body') or '')[:500]}\n"); sys.exit(1)
sys.stdout.write(env.get("body") or "")
PY
  fi
}
```

共享凭据只能创建和删除(见"组织设置"),所以用它无法列出或读回任何内容,
也无法上传文件(代理传送的是 JSON,而不是 multipart)。下面的流程两者都不需要。

## 组织设置(管理员:上线前必须完成)

本文档的隔离依赖两项技能本身无法强制执行的设置:

1. **共享凭据:使用独立的项目,只能创建和删除。**为 QM 的共享密钥提供一个专用的 Kernel 项目,以及一个仅限于该项目的密钥(`browsers`、`profiles` 和
   `proxies`,每个都在 `projects/<id>/*` 上拥有 `use`、`create`、`write` 和 `delete`,且没有
   `read`)。Kernel 要求项目范围的 `browsers:use` 才能创建浏览器,
   而这也让该密钥能列出并连接其项目中每一个正在运行的浏览器,
   所以绝不要把共享密钥放进别人自己的密钥或其他工具所用的项目。然后
   为 `api.onkernel.com` 配置代理条目,方法只允许 `POST` 和 `DELETE`,
   路径为 `/browsers`、`/profiles` 和 `/proxies`。绝不要允许 `GET`:路径按前缀匹配,
   所以任何 `GET` 都会让调用者列出每个人的配置文件和正在运行的浏览器,
   而它们的名称就是任何人打开别人已登录浏览器所需的全部。
   本流程中没有任何步骤需要 `GET`;实时查看和 CDP URL 会在创建时一并返回。
2. **个人密钥限定在此人范围内。**个人自己的 `KERNEL_API_KEY` 不得是
   账户级密钥;否则会绕过第 1 条。给他们自己的 Kernel 项目和一个
   仅限于该项目的密钥,原因同上:在同一个项目内,任何能
   创建浏览器的密钥都能看到每个正在运行的浏览器。

如果你是智能体,并且清单中的 `service_kernel` 行允许 `GET`,告诉此人
(以及组织管理员)配置文件尚未隔离。不要绕过这个问题。

## 配置文件

此人的配置文件是一个 Kernel 浏览器配置文件,其名称保存在他们的密钥链中
(`KERNEL_PROFILE`)。它保存他们的登录状态:用它启动的浏览器一开始就是已登录的,
而用 `save_changes: true` 启动的浏览器会在被
DELETE 或超时时把它的 cookie 写回(关闭 CDP 不会保存)。不使用 Managed Auth:此人在实时查看中
登录一次,配置文件就会保持住。

配置文件名称是机密,不是标签。一个 Kernel 账户保存每个人的配置文件,
且不记录所有者,所以任何知道名称的人都能启动一个以该人身份登录的浏览器。
因此组织共享的 Kernel 凭据只能允许创建和
删除(见下文"组织设置");不要用任何密钥列出配置文件或浏览器,
也不要试图按名称或时间远近去找某人的配置文件。他们的配置文件就是
其密钥链中的那一个,仅此而已。如果缺失,就运行首次设置;不要去到处找。

Kernel 配置文件必须通过 API 预先创建 — 指定了不存在的配置文件的浏览器创建会返回
400(这是这里出现 400 的常见原因,而不是 Kernel 故障)。在
首次设置期间,以及下面的创建返回 400 时,都用密钥链中**已有**的名称创建配置文件 — 绝不要用新的随机名称,那会使该凭据成为孤儿:

```bash
kapi POST /profiles "{\"name\":\"$KERNEL_PROFILE\"}" > /dev/null
```

## 此人的静态 IP

每个人还会得到自己的 Kernel ISP 代理:一个位于住宅 ISP 上的静态出口 IP,
每次会话都相同。会记住设备的网站(尤其是 LinkedIn)看到的是
同一个人使用同一个连接,而不是每次运行都换一个新地址,这能避免
已保存的登录触发验证。它的 id 保存在他们的密钥链中,即
`KERNEL_PROXY_ID`(服务 `kernel-proxy`);要像对待配置文件名称一样对待它(它决定
浏览器使用谁的地址),所以它只能来自密钥链。

如果清单中没有 `KERNEL_PROXY_ID` 句柄,就运行 SKILL.md 为配置文件给出的同样的存在性检查
(`envKey == "KERNEL_PROXY_ID"`)。只有在不存在时,才创建一个
并注册它,这属于同一个静默的首次设置(不要先询问):

```bash
PX=$(kapi POST /proxies '{"type":"isp","name":"qm-<person>-isp","config":{"country":"US"}}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
[ -n "$PX" ] || { echo "proxy create returned no id; nothing registered" >&2; exit 1; }
curl -fsS -X POST "$AGENT_API_URL/v1/keychain/credentials" -H "x-agent-capability: $AGENT_API_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"service\":\"kernel-proxy\",\"envKey\":\"KERNEL_PROXY_ID\",\"secret\":\"$PX\"}" > /dev/null
```

ISP 代理存在于 US、GB、FR、DE 和 SG;选择此人所在的国家。如果共享
凭据拒绝 `/proxies`(path_not_allowed),说明组织没有启用它;不带代理
启动,并告诉此人。来自新 IP 的第一次会话,可能会要求
此人对他们在别处已登录过的网站验证一次;之后就会
稳定。如果创建因代理失败(`proxy_id` not found),用
`kapi POST /proxies/$KERNEL_PROXY_ID/check` 检查它(仅限自有密钥或环境变量密钥;共享凭据
没有读取权限,所以该检查会被拒绝),并告诉此人,而不是悄悄地
不带代理启动。

## 创建浏览器

带上此人的配置文件和代理。一个配置文件同一时间只能有**一个**浏览器写入:
Kernel 允许同一个配置文件上有并发的浏览器,而每次保存都会替换整个
配置文件,所以第二个写入者会悄无声息地覆盖第一个。由于无法列出浏览器,
把你自己的写入者记录在此人的密钥链中(`KERNEL_ACTIVE`,服务
`kernel-active`,值 `<session_id>:<epoch>`),并且在存在比浏览器超时更新的记录时以只读方式启动。
它存在时,在 `credentials` 中指明它的句柄(不存在 = 没有写入者):

```bash
SAVE=true
case "${KERNEL_ACTIVE:-}" in *:*) [ $(( $(date +%s) - ${KERNEL_ACTIVE#*:} )) -lt 1800 ] && SAVE=false;; esac
CREATE=$(kapi POST /browsers "{\"stealth\":true,\"headless\":false,\"timeout_seconds\":1800,\"proxy_id\":\"$KERNEL_PROXY_ID\",\"profile\":{\"name\":\"$KERNEL_PROFILE\",\"save_changes\":$SAVE}}")
CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('cdp_ws_url',''))")
KERNEL_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))")
LIVE_VIEW=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('browser_live_view_url',''))")
```

当 `SAVE=true` 时,立即占用该配置文件:

```bash
[ "$SAVE" = true ] && curl -fsS -X POST "$AGENT_API_URL/v1/keychain/credentials" \
  -H "x-agent-capability: $AGENT_API_TOKEN" -H 'content-type: application/json' \
  -d "{\"service\":\"kernel-active\",\"envKey\":\"KERNEL_ACTIVE\",\"secret\":\"$KERNEL_SID:$(date +%s)\"}" > /dev/null
```

`CDP_URL` 是运行器直接驱动的 websocket。如果 `SAVE` 为 `false`,汇报时要说明:
本次运行中登录的任何内容都不会被保留。这条记录不是锁 —
同一时刻启动的两次运行都可能看不到记录 — 所以一个人的配置文件上,
一次只保持一个 browse 运行。

## 向浏览器提供文件

文件存放在 `/home/kernel`。这需要真正的密钥(自有或环境变量);共享凭据
无法承载文件上传,所以要如实说明,而不要随意变通:

```bash
curl -fsS -X POST "https://api.onkernel.com/browsers/$KERNEL_SID/fs/upload" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -F "files[]=@/tmp/receipt.jpg;filename=receipt.jpg" -F "dest_dir=/home/kernel"
```

然后按 SKILL.md 所述,用 `BROWSE_FILES="/home/kernel/receipt.jpg"` 运行任务。

## 处理登录屏障的路由

此人在实时浏览器上登录一次;配置文件会保持住。

1. 把实时浏览器导航到屏障 URL(从 `/tmp/wall-url.txt` 读取,绝不要放入 shell
   源码),让此人落在登录页面上,然后把 `$LIVE_VIEW` 交给他们 —
   这是持有者凭证,绝不要自己打开。SKILL.md 中共享的 `browse-nav.py`(在
   其屏障步骤中编写)负责引导:

   ```bash
   CDP_URL="$CDP_URL" /opt/browser-engine/venv/bin/python /tmp/browse-nav.py
   ```

2. 他们登录、完成任何双重验证,然后说"完成"。如果浏览器是以
   `SAVE=false` 启动的(另一个浏览器占着该配置文件),先停止那一个并重新启动,否则
   这次登录会丢失。
3. DELETE 该浏览器(这正是写入配置文件的动作),等待约 10 秒,创建一个新的
   (它启动时就是已登录的),并重新运行任务。

设定预期:配置文件保留会话 cookie;它无法再次应答质询。每次访问都要重新验证
(短信/邮件 OTP)的网站仍需要此人参与,而当
网站最终让会话过期时,下一次运行会撞上屏障,你需要重复这一流程。
不要为此使用 Kernel Managed Auth 或保存的 Kernel 凭据 — 此人的
密码绝不离开他们。

## 清理

```bash
kapi DELETE "/browsers/$KERNEL_SID"
# release the profile if this run held it
[ "$SAVE" = true ] && curl -fsS -X POST "$AGENT_API_URL/v1/keychain/credentials" \
  -H "x-agent-capability: $AGENT_API_TOKEN" -H 'content-type: application/json' \
  -d '{"service":"kernel-active","envKey":"KERNEL_ACTIVE","secret":"none:0"}' > /dev/null
```

## API 参考

当某个调用的结果出乎意料时,请阅读这些文档,而不是猜测:

- 配置文件(save_changes、并发):https://www.kernel.sh/docs/browsers/profiles
- ISP 代理(静态出口 IP):https://www.kernel.sh/docs/proxies/isp
- 浏览器(创建/删除、配置文件、实时查看、fs 上传):https://www.kernel.sh/docs/api-reference/browsers
