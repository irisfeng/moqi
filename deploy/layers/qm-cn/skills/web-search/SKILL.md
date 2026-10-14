---
name: web-search
description: 联网查询公开信息（国内直连）。优先用博查搜索 API（BOCHA_API_KEY 授权，返回干净 JSON），无密钥时回退 curl 搜索必应中国/百度。回答天气、新闻、价格、政策等需要最新外部信息的问题。用户问题需要外部或最新信息时使用；公司内部与敏感信息一律不外发到搜索引擎。
---

# 联网查询（web-search）

沙箱可直接访问国内互联网。需要最新或外部信息时，按下面的顺序完成"搜索 → 抓取 → 带来源回答"。

**通道选择是硬性顺序，不要跳过第一步：先执行 `[ -n "$BOCHA_API_KEY" ] && echo HAS || echo EMPTY`；输出 HAS 必须走通道一，只有 EMPTY 或通道一失败才走通道二。**

## 通道一：博查 API（有密钥时必用）

环境变量 `BOCHA_API_KEY` 存在时优先使用（管理员通过密钥链授钥后自动注入）：

    curl -s -m 15 -X POST "https://api.bochaai.com/v1/web-search" \
      -H "Authorization: Bearer $BOCHA_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"query": "关键词", "count": 10}'

- 返回 JSON：`data.webPages.value[]` 含 name / url / summary / snippet，直接取用，无需解析 HTML
- 若返回 401/403 说明密钥失效：如实告知用户密钥问题，然后走通道二
- 若返回格式与预期不同，先打印响应结构再调整字段路径

## 通道二：curl 搜索（兜底，无密钥或 API 失败时）

优先必应中国（结果干净）：

    curl -s -m 15 -G \
      -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" \
      "https://cn.bing.com/search" --data-urlencode "q=关键词"

- 必须带上面的 User-Agent，否则会被拒
- 从返回 HTML 提取结果标题、摘要、目标 URL（`<h2><a href=` 区块）
- 必应不可用或结果差时换百度：`https://www.baidu.com/s?wd=关键词`（同样必须带 UA）

## 抓取正文（需要页面细节时）

选 2-3 条最相关结果抓取：

    curl -sL -m 20 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" "URL" \
      | python3 -c "import sys,re,html; t=sys.stdin.read(); t=re.sub(r'(?is)<(script|style).*?</\\1>','',t); t=re.sub(r'<[^>]+>',' ',t); print(html.unescape(re.sub(r'\\s+',' ',t))[:4000])"

## 纪律

- 回答必须附来源（标题 + URL）；没有来源的结论明确标注"未核实"
- 只访问国内可直连站点；国外站点连不上时如实说明，单目标最多重试 1 次
- 单次搜索超时 15 秒，整轮任务最多 5 次网络请求
- 公司内部信息、人员数据和其他敏感内容不得作为搜索词外发；拿不准先问用户
