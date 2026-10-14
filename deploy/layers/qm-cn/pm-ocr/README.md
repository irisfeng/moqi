# 文字识别服务（pm-ocr）

一个独立的小服务，用开源的 RapidOCR 识别图片中的文字，供需要识别扫描件或截图的部署按需接入。QM 核心和 Web UI 不依赖它。

```bash
docker build -t pm-ocr deploy/layers/qm-cn/pm-ocr
docker run -d -p 8092:8092 pm-ocr
```

- `GET /healthz`：健康检查。
- `POST /ocr`：请求体为图片，返回识别出的文字（JSON）。请求体最大 30 MB。

默认从国内 PyPI 镜像安装依赖；在其他网络环境中用 `--build-arg PIP_INDEX_FLAG=` 改回官方 PyPI。
