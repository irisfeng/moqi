FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
ARG PIP_INDEX_FLAG="--index-url https://mirrors.aliyun.com/pypi/simple/"
RUN pip install --no-cache-dir ${PIP_INDEX_FLAG} rapidocr-onnxruntime==1.3.24
COPY server.py /app/server.py
ENV PYTHONUNBUFFERED=1
EXPOSE 8092
CMD ["python3", "/app/server.py"]
