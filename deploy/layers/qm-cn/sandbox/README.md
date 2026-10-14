# 沙箱镜像（qm-cn）

在 QM 的沙箱镜像之上加装办公文档工具（python-docx、python-pptx、openpyxl 等）和 ppt-master 技能。

## 构建前准备 ppt-master

`Dockerfile` 从同目录的 `ppt-master-skill.tarbin` 安装 ppt-master 4.8.0。这个文件不入库，构建前在仓库根目录按下面的步骤生成：

```bash
git clone --depth 1 --branch v4.8.0 https://github.com/hugohe3/ppt-master /tmp/ppt-master-src
tar -C /tmp/ppt-master-src/skills -cf deploy/layers/qm-cn/sandbox/ppt-master-skill.tarbin ppt-master
```

构建时会检查 `SKILL.md` 中的版本号，版本不符则构建失败。ppt-master 以 MIT 许可发布，许可文件见 `deploy/layers/qm-cn/skills/ppt-master/LICENSE`。

## 构建

在仓库根目录先构建 QM 的本地沙箱镜像 `qm-sandbox-local:latest`，它是这里 `BASE` 的默认值，再在它之上构建：

```bash
npm run sandbox:local:build
docker build -t qm-sandbox-cn deploy/layers/qm-cn/sandbox
```

## 启用

在部署目录的 `qm.config.jsonc` 中选用这个镜像，然后重新部署：

```jsonc
"sandbox": { "backend": "local", "image": "qm-sandbox-cn" }
```

不启用时，办公文档和 ppt-master 技能所在的沙箱里没有它们需要的工具。

在无法直接访问 PyPI 的环境中，用 `--build-arg PIP_INDEX_FLAG="--index-url <镜像地址>"` 指定 Python 包镜像。
