FROM nvidia/cuda:12.4.1-base-ubuntu22.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

# PIP_INDEX mirrors the PyPI index for networks close to it; the default works everywhere else.
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
# Dependencies first: server.py changes must not re-download torch.
RUN pip3 install --no-cache-dir -i ${PIP_INDEX} fastapi uvicorn torch transformers pydantic
# Qwen3-TTS ships its own loader; transformers' AutoModel doesn't know `qwen3_tts`.
RUN pip3 install --no-cache-dir -i ${PIP_INDEX} qwen-tts
# qwen-tts shells out to SoX; torch's Triton path JIT-compiles with a C compiler
# and Python headers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends sox libsox-fmt-all build-essential python3-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py .

# Model downloads honor HF_ENDPOINT (e.g. https://hf-mirror.com) at run time.
EXPOSE 8810
CMD ["python3", "server.py", "--port", "8810"]
