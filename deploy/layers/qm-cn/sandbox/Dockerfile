ARG BASE=qm-sandbox-local:latest
FROM ${BASE}
ARG PIP_INDEX_FLAG=

RUN pip3 install --no-cache-dir --break-system-packages ${PIP_INDEX_FLAG} \
      "setuptools>=70,<81" \
      python-docx==1.1.2 \
      python-pptx==1.0.2 \
      openpyxl==3.1.5 \
  && python3 -c "import docx, pptx, openpyxl" \
  && python3 -c "import setuptools; assert int(setuptools.__version__.split('.')[0]) >= 70"

ADD ppt-master-skill.tarbin /tmp/pptxsrc/
RUN mkdir -p /opt/skills \
  && mv /tmp/pptxsrc/ppt-master /opt/skills/ppt-master \
  && grep -q 'version: "4.8.0"' /opt/skills/ppt-master/SKILL.md \
  && rm -rf /tmp/pptxsrc

RUN pip3 install --no-cache-dir --break-system-packages ${PIP_INDEX_FLAG} \
      "PyYAML>=6.0" \
      "XlsxWriter>=3.0.0" \
      "skia-pathops>=0.9.2" \
      "uharfbuzz>=0.50.0" \
      "edge-tts>=7.2.8" \
      "PyMuPDF>=1.23.0" \
      "mammoth>=1.6.0" \
      "markdownify>=0.11.6" \
      "ebooklib>=0.18" \
      "nbconvert>=7.0.0" \
      "Pillow>=9.0.0" \
      "numpy>=1.20.0" \
      "requests>=2.31.0" \
      "beautifulsoup4>=4.12.0" \
      "curl_cffi>=0.7.0" \
      "flask>=3.0.0" \
  && python3 -c "import pptx, yaml, fitz, PIL, xlsxwriter"
