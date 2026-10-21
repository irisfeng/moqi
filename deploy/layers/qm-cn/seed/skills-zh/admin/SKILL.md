---
name: admin
description: 代组织管理员执行操作 — 当你正在对话的用户是组织管理员且由其本人发起本轮对话时,管理员 API(范围目录、各范围的配置与 SOUL、任意范围的记忆、会话记录与捕获的提示词、文件、用户名册与外部用户、审计/错误/指标/出口流量)会接受你的令牌。当管理员要求你查看或修改组织级或其他范围的任何内容,或有人询问自己是否为管理员时使用。
---

# admin — 在聊天中代组织管理员执行操作

下列操作请使用原生 `admin` 工具。它的固定动作调用相同的
`/v1/admin/*` 处理程序,并接受相同的取值;配置和提供方的取值
对象由这些现有的处理程序校验。二进制文件和完整捕获提示词的下载、原始密钥的设置、连接器配置,
以及服务凭据配置,仍然使用自身 API,绝不通过原生工具参数。你是**以管理员本人的身份**行事:每次调用都会对照实时授权
存储重新检查授权;现有的管理员审计事件仍记在其名下。两条长期规则:
**任何变更之前先确认**(准确说明你要改什么、在哪里改),变更之后
准确汇报改了什么。读取操作直接做即可。

## 系统管理

系统管理不限于这个 API。经过验证的管理员可以使用另行授权的
基础设施或提供方访问权限来诊断、修复和管理该实例,
包括其他用户拥有的资源。普通的资源所有者限制
并不要求所有者亲自完成这些工作。仅限所有者的 API 拒绝并不会撤销另行
授权的管理访问权限;换用其他途径之前先验证一下。在
管理员自己的权限下行事,不属于冒充或规避。

保留凭据授权、提供方权限、明确的限制以及变更审批。
仅凭管理员身份不会提供任何提供方凭据。不要借用其他用户的身份,
不要使用未授权的凭据,也不要绕过下文仅限门户的操作。检查提供方
账号和目标,让变更始终记在管理员名下,并且只披露本次
会话的受众有权看到的内容。涉及云操作时,还要加载 cloud-cli。

## 管理员 API 限制

API 强制执行的限制(不要提供它会拒绝的操作):

- 你的令牌只在管理员**亲自发起**的轮次中提权 — 在自主运行(定时任务、webhook)中,
  无论该运行归谁所有,管理平面都会拒绝它。
- 返回私密内容的读取操作 — 会话记录、文件、笔记本、日志、其他
  范围的配置 — 可在与管理员的**私信**中进行,或在管理员实时轮次的**开放**会话中进行。组织、个人和会话的共享限制
  全部适用;任何隔离设置都仍然要求在私信中进行。请求使用
  已认证发言者的实时管理员授权,而不是其他参与者的权限。
  开放会话中的读取可能向会话中的所有人暴露私密数据:只检索
  并汇报请求所需的内容。另有两个例外:面向组织的
  记忆/配置读取在任何地方都可用(组织内容对每个会话都是公开的),
  并且定时任务可以携带**无人值守读取授权**(定时任务上的 `unattendedGrants`:
  `admin.sessions.read`、`admin.audit.read`、`admin.metrics.read`、`admin.egress.read`、
  `admin.files.read`)— 只能由该定时任务的所有者在实时轮次中设置,所有者必须是
  当前的组织管理员,且设置在以其本人身份运行的个人范围定时任务上。每项授权只对该定时任务的自主触发开放
  其自身对应的 GET 路由,并以所有者的名义记入审计
  (实时重新检查 — 撤销其管理员授权即关闭该权限)。其他变更在
  任何地方都可进行;房间里的人会看到改了什么,这是有意的设计。
- **授权变更(提升/撤销)和冒充**通过你操作时**仅限门户**。
- 不支持批量配置导入。请改用各个单独的配置资源。

所有调用的形式相同 — 只有方法/路径/请求体不同:

```bash
curl -fsS -H "x-agent-capability: $AGENT_API_TOKEN" "$AGENT_API_URL/v1/admin/..."
```

任何人都可以查询管理员状态(回答"我是管理员吗?"也用这个):

```bash
GET /v1/admin/whoami        → {"isAdmin":true,"role":"org_admin","scopeId":"org:…"} or {"isAdmin":false}
```

## 检查连接器来源

在管理员入门引导期间,先静默检查这一项,再提议<!--slack-->设置 Slack 机器人或<!--/slack-->个人连接。来源有两种:Composio,或组织自己的 OAuth 应用。绝不要查看部署密钥。

**Composio。** 当 `GET /v1/composio/toolkits` 成功时,说明 Composio 可用。`composio_unavailable` 错误只表示它对这个人不可用;组织仍可能有一个未授权给他的密钥。要检查组织,读取 `GET /v1/admin/scopes/<org scope>?view=credentials`:若存在 `serviceCredentials` 条目,且 `enabled: true`、`hasSecret: true`、`delivery: "env"`、`envKey: "COMPOSIO_API_KEY"`,则说明 Composio 已配置。

**自有 OAuth 应用。** 实时的"已连接应用"区块反映的是已通过客户端凭据配置的提供方,来源为 Admin → Connectors 或部署密钥。出现"No direct OAuth app connections are configured"这一行,表示一个都没有配置,即使"已连接"下出现了 MCP 应用也一样。没有这一行,则至少配置了一个提供方。`GET /v1/admin/scopes/<org scope>?view=connectors` 只显示在 Admin → Connectors 中添加的应用,不包含由部署密钥设置的应用,因此不能用来证明不存在。

只有在工具包读取失败、且组织检查没有发现这样的凭据时,才算 Composio 不存在。只要任一来源存在,就静默跳过。如果该区块缺失或某次读取失败,按未知处理,而不是不存在,也不要提议设置。只有两者都确认不存在时,才发送一条简短消息:

- Composio(推荐):一个项目密钥即可覆盖大多数应用。在 Admin → Credentials 中把它添加为组织服务凭据,环境变量键为 `COMPOSIO_API_KEY`,并按 QM 的 `docs/composio.md` 所述设置回调验证。如果他们更愿意现在直接粘贴密钥,用 `POST /v1/keychain/drops`(`{"service":"composio","envKey":"COMPOSIO_API_KEY","purpose":"…"}`)生成一次性投递链接,并分享它的 `url`。通过投递提交的密钥只为他们本人启用 Composio;团队成员需要组织凭据。
- 自有 OAuth 应用:在 Admin → Connectors 中添加每个提供方。每个都需要回调 URL `<web origin>/v1/connectors/oauth/<provider>/callback`,连接器页面也会显示它。

链接:web origin 是"已连接应用"区块中连接页面 URL 的来源(`<web origin>/keychain`)。链接到 `<web origin>/admin/credentials` 和 `<web origin>/admin/connectors`。如果没有这一行,就只写出页面名称而不加链接,并提供投递链接。绝不要编造 URL,也不要在聊天中索要密钥或客户端密钥。绝不要要求普通用户配置来源。

<!--slack-->## 引导安装 Slack

在管理员入门引导期间提议设置 Slack 机器人之前,先静默检查这一项。它与个人账号连接是分开的。先验证管理员状态。在
人工发起的管理员轮次中,读取 `GET /v1/admin/slack-installation`;它返回设置
元数据,不返回令牌。读取失败意味着未知,而不是不存在。绝不要
查看部署密钥来推断状态。

- `configured: true`:入门引导期间静默跳过,包括由环境变量支持的
  安装。不要添加设置标题,不要说"已连接",也不要要求发测试私信。
  配置并不等于实时连通性检查;仅在被询问时才排查问题。
- `managed: true`、`configured: false`:除非管理员
  要求恢复或重新启用,否则不要动已禁用的设置。入门引导期间不要推介它。
- `source: "invalid_environment"`:这是未完成的设置,而不是应用不存在。
  不要创建重复的应用;提议通过其安全页面完成现有的设置。
- 只有成功的读取确认机器人确实不存在,才值得提出新的设置建议。
  尊重此前的推迟决定,继续进行个人连接。

对于公司自有的配置开通,状态响应会提供 `setup.tokenUrl`、
`setup.submitUrl` 和 `setup.installUrl`。它们是稳定的、需认证的 QM 入口
链接,不是会过期的票据。绝不要编造 URL,也不要在 shell 中生成启动票据。

在网页端,使用返回的 URL 发布一次 **[Set up Slack](setup.submitUrl)**。
会话会在一条消息中渲染一份实时检查清单,同时包含三个链接:
**Create token**、**Submit token** 和 **Add to Slack**,以及说明用的 GIF。
它会就地检查进度,无需助手再回复。不要用文字重复
这份检查清单。在其他界面上,把返回的三个链接一并呈现:

1. Create token:打开 `setup.tokenUrl`。在 **App Configuration Tokens** 下,选择
   **Generate Token**,选择目标工作区,并复制 **access token**,
   而不是 refresh token。
2. Submit token:打开 `setup.submitUrl`,即安全的配置开通表单。这
   不是通用的密钥链令牌投递。该令牌可以管理他们在
   该工作区拥有的其他应用。QM 创建/配置它的应用,然后丢弃该令牌。
   绝不要把它粘贴到聊天、记忆、文件或密钥链中。
3. Add to Slack:提交令牌后打开 `setup.installUrl`,检查
   工作区,然后选择 **Allow**。该应用归公司所有。

`setup.appReady` 表示应用已存在;并不表示已安装。
只有经过验证的 `setup.connected` 加上 `configured`,才可以说 **Connected**。
在声称机器人可用之前,要求得到一次真实的回复,但这不是入门引导的前提条件。
状态读取失败或 `setupUnavailable` 意味着未知,而不是不存在。不要重新开始配置开通,
也不要创建重复的应用。重试现有链接或遵循恢复指引。

较旧的服务可能返回 `installAvailable: true` 而没有 `setup`。这只表示
有经过认证的仪表盘 **Add to Slack** 操作。把它已知的入口链接和
说明一并给出,而不要承诺检查清单或编造令牌投递。

在没有托管安装的情况下,使用返回的 `createUrl` 和已知仪表盘的
工作区应用指南。不要索要此流程无法使用的配置令牌。
让他们只在其安全表单中输入凭据。不要猜测范围、回调
URL 或凭据要求。设置是可选的;若被推迟,继续入门引导。<!--/slack-->

## 查找范围

大多数端点接受 `?scope=<scopeId>`(`org:<org>`、`personal:<user>`、`channel:<id>`)。
不要猜测 id — 请列出它们:

```bash
GET /v1/admin/scopes        → every scope with display labels (#channel names, people) and what lives there
```

## 读取并管理范围的配置

```bash
GET /v1/admin/scopes/<scopeId>                → resolved config: commandPolicy, soul (+version), egress, flags, connectors, serviceCredentials
PUT /v1/admin/scopes/<scopeId>/<resource>     → resource ∈ soul | command-policy | egress |
                                                connectors | service-credentials |
                                                base-model (org-wide LLM; body { modelId } — e.g. gpt-5.5; empty string clears)
```

先 GET,再 PUT 修正后的值(`soul` 接受 `{content}`,`egress` 接受
`{allowedHosts,deniedHosts}`,开关类接受 `{on}`)。更改在下一轮生效。

## 读取并修复任意范围的记忆

```bash
GET /v1/admin/memory?scope=<scopeId>          → that scope's whole notebook
PUT /v1/admin/memory?scope=<scopeId>          {"content":"…full replacement…"}
```

(对于"在整个组织范围内记住这件事",完全不需要管理平面 — 在记忆自身 API 上使用 `"scope":"org"`
是更轻量的途径;参见 memory 技能。)

## 查看活动与内容

```bash
GET /v1/admin/sessions?scope=&limit=&cursor=  → conversation listing (turns, last activity); pass nextCursor for older rows
GET /v1/admin/sessions/<id>?scope=            → a transcript
GET /v1/admin/sessions/<id>/llm?scope=        → captured provider requests — what the model actually saw (debugging "why did it do X")
GET /v1/admin/runs?scope=                     → queued/in-flight/recent runs
GET /v1/admin/files?scope=                    → document store; read?id= / download?id= for content
GET /v1/admin/volumes?scope=                  → a scope's computer/backup contents (sizes only)
GET /v1/admin/crons|deployments|skills?scope= → artifacts by owner
```

## 可观测性

```bash
GET /v1/admin/audit?scope=     GET /v1/admin/errors?scope=    GET /v1/admin/metrics?scope=
GET /v1/admin/egress?scope=    GET /v1/admin/retention
GET /v1/admin/users            → roster + admin status (org-wide)
```

## 外部用户

外部协作者通过邮箱准入,带有角色和到期时间;在到期之前,他们用该地址登录
门户。与名册一起列出:

```bash
GET /v1/admin/users                          → externalUsers: [{email, role, expiresAt, invitedBy, status: active|expired}]
POST /v1/admin/external-users                {"email":"ana@partner.com","expiresAt":"2026-12-31"}   role defaults to member; expiresAt required (a bare date means end of that day UTC; ISO date-time or epoch ms also work)
DELETE /v1/admin/external-users/<email>      → revokes access now; the row stays listed as expired (a DELETE a day after expiry removes it)
```

邀请或撤销之前先与管理员确认 — 说明是谁、什么角色、到什么时候。
邀请邮件需要在核心服务上配置 Resend(`RESEND_API_KEY` +
`AUTH_EMAIL_FROM`);没有配置时用户仍会被添加。当响应中
`emailSent:false` 时,告诉管理员原因(`emailProblem`),并把 `signInUrl` 交给他们
自行转发。外部用户的 `org_admin` 角色与其他所有授权变更一样仅限门户
— 不要提供。

## 管理员授权(提升 / 撤销)

无法通过你完成:谁管理组织只能在管理员仪表盘中更改,
由管理员在那里直接操作。若被问到,请指引他们去那里 — 不要尝试 API
(`POST/DELETE /v1/admin/grants` 会拒绝智能体令牌)。

## 失败情形

- `403 admin grant required for this scope` — 该用户不是组织管理员(或刚被
  撤销)。如实告知;不要重试或设法绕过。
- `403 … require a turn the admin started themselves` — 这是自主运行
  (定时任务/webhook);管理操作只能搭乘管理员亲自发起的轮次。如实告知。
- `403 … returns private content — ask the agent in a DM` — 共享房间对这次实时管理员轮次没有有效的开放访问权限;
  告诉管理员到与你的私信中再问一次(或者,对于他们希望按计划
  定期执行的读取,在个人范围的定时任务上设置无人值守读取授权 — 从
  他们的私信中进行,绝不要从这里进行)。
- `403 … grant changes (promote/revoke) are portal-only` — 指引他们去仪表盘。
- `403 granting or removing org admin for an external user is portal-only …` — 同样的
  答复:仪表盘。
- `409 that address already belongs to a member of the org …` — 组织邮箱域名、Slack
  目录、登录允许列表,或已经使用过智能体的人。他们不是外部用户;
  要提升他们,请指引管理员到仪表盘中的 Grant org admin,并
  告诉他们把邮箱作为主体 ID 输入。此人不必先出现在 Users 中。
- `409 that address holds an org admin grant of its own …` — 管理员须先在仪表盘的 Admins 下
  管理该授权。
- `403 capability token not valid for this route` — 此核心早于智能体管理员
  访问功能;用户必须使用管理员仪表盘。
