---
name: connect-apps
description: 通过一次性的 OAuth 授权链接,为用户连接管理员已启用的 SaaS 应用。
---

## 连接 SaaS 应用

通过已认证的 QM API 上的 `GET /v1/composio/toolkits` 检查 Composio 是否可用。可用时,加载 `composio` 技能,并使用它的发现与授权流程,而不是
下面的直接 OAuth 流程。直接 OAuth 列表为空,或原生的
`oauth_not_configured` 错误,并不说明 Composio 的可用情况。保留明确的
应用限制和账号权限;绝不要为了规避拒绝而切换凭据。

当设置了 `$AGENT_OAUTH_CONSENT_TOKEN` 时,你可以通过用户点击的浏览器
授权链接帮助其连接 SaaS 应用 — 你永远不会看到或输入他们的密码。实时的 Connected apps 块就是
直接 OAuth 的允许列表:只为管理员配置过的提供方提供直接 OAuth 链接,
并且当该列表为空时,不提供任何直接 OAuth 链接。为所选提供方生成一个一次性链接,然后把完整的 URL 交给用户打开:
curl -sS -X POST "$AGENT_API_URL/v1/connectors/oauth/consent/mint" \
      -H "X-Agent-Capability: $AGENT_OAUTH_CONSENT_TOKEN" -H 'content-type: application/json' \
-d '{"provider":"<configured-provider>"}'

- 响应中有 `connectUrl` — 把**这个**确切的 URL 交给用户(它是完整的公开点击链接)。
  不要自己构造它,也不要在前面拼接 `$AGENT_API_URL` — 那个私有基础地址
  浏览器无法访问。
- 如果生成链接时返回 `oauth_not_configured`,说明原生提供方未配置。不要重试那条
  直接 OAuth 路径,也不要重新发送旧链接;这并不能说明所有访问途径都不可用。
- 你无法自己打开该链接;转交 URL,告诉他们点击 Allow,然后回来。他们
  连接之后,该应用的工具/技能就可以在你与他们的一对一会话中使用。

## 连接个人 Slack 账号

当有人要求连接 Slack,或要从 Slack 使用其现有的网页连接器时,在网页聊天中提供个人 Slack 关联小组件,或者引导他们前往 QM 网页设置(`/?view=settings`),并在 Slack 中点击 **Link your Slack account**。他们必须先用现有的网页账号登录才能连接。这会授权个人 Slack 访问,并把其经过验证的 Slack 身份关联到该 QM 账号。工作区机器人的安装是另外一回事。不要创建通用的 Composio Slack 链接,也不要根据相同的邮箱来推断身份。

在网页聊天中,用 `::link-slack-account{}` 提供个人 Slack 账号关联,把它单独放成一个段落,不要放在代码围栏和引用之中。当有人想要 Slack 搜索、代其执行操作,或从 Slack 访问其现有的网页连接器时使用它。这会显示个人关联卡片及其经过验证的连接状态,而不显示通用的应用选择器。必须先完成公司机器人的安装;该单独的管理员步骤使用 `::add-to-slack{}`。在 Slack 中,让他们在登录现有网页账号的情况下前往 QM 网页设置;网页小组件指令不会在 Slack 中渲染。
