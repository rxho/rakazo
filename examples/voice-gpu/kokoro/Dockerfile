FROM python:3.11-slim

# espeak-ng backs misaki's non-Chinese fallback; ffmpeg converts to MP3.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg espeak-ng \
  && rm -rf /var/lib/apt/lists/*

# PIP_INDEX mirrors the PyPI index for networks close to it; the default works everywhere else.
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
# CPU-only serving; the stock PyPI torch wheel runs fine without a GPU.
RUN pip3 install --no-cache-dir -i ${PIP_INDEX} torch soundfile fastapi uvicorn
RUN pip3 install --no-cache-dir -i ${PIP_INDEX} kokoro "misaki[zh]"

WORKDIR /app
COPY server.py .

# Model weights download from the HF endpoint at first start.
EXPOSE 8820
CMD ["python3", "server.py", "--port", "8820"]
