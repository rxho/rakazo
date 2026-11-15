"""
OpenAI-compatible speech server for Kokoro-82M: the speed tier.

Same endpoints Rakazo's `openai-compatible` voice provider speaks as the
Qwen3-TTS server (examples/voice-gpu/qwen3-tts), so switching tiers is just a
Server URL change in Voice settings. Kokoro is a non-autoregressive 82M model:
a short opener synthesizes in a few hundred milliseconds on CPU (the Qwen3
server's fixed cost is ~3s on the same host), which puts a call's first audio
around two seconds end to end. Chinese only (Kokoro `z` pipeline voices).

  GET  /v1/models
  GET  /v1/audio/voices
  POST /v1/audio/speech  – {model, voice, input, response_format:"mp3"} -> MP3
"""

from __future__ import annotations

import argparse
import io
import os
import subprocess
import tempfile
from collections import OrderedDict

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel
from kokoro import KPipeline

DEFAULT_MODEL = "hexgrad/Kokoro-82M"
# Kokoro's Chinese voices (zf_* female, zm_* male); keys are the ids Rakazo sees.
VOICES = {
    "xiaobei": "zf_xiaobei",
    "xiaoni": "zf_xiaoni",
    "xiaoxiao": "zf_xiaoxiao",
    "xiaoyi": "zf_xiaoyi",
    "yunjian": "zm_yunjian",
    "yunxi": "zm_yunxi",
    "yunxia": "zm_yunxia",
    "yunyang": "zm_yunyang",
}
SAMPLE_RATE = 24_000

parser = argparse.ArgumentParser()
parser.add_argument("--model", default=os.environ.get("TTS_MODEL", DEFAULT_MODEL))
parser.add_argument("--host", default="0.0.0.0")
parser.add_argument("--port", type=int, default=8820)
args, _ = parser.parse_known_args()

app = FastAPI()
pipeline = KPipeline(lang_code="z", repo_id=args.model)

SENTENCE_END = "。！？.!?"
CJK_END = "。！？"
SOFT_BREAK = "，、；,;:"


def split_sentences(text: str, max_chars: int = 64) -> list[str]:
    """Splits on sentence enders, then at soft breaks when a piece is too long."""
    parts: list[str] = []
    start = 0
    for i, ch in enumerate(text):
        if ch not in SENTENCE_END:
            continue
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if ch in CJK_END or nxt in " \n\"'）)]」』" or nxt == "":
            parts.append(text[start : i + 1])
            start = i + 1
    parts.append(text[start:])
    out: list[str] = []
    for part in parts:
        part = part.strip()
        while len(part) > max_chars:
            cut = max(part.rfind(c, 0, max_chars) for c in SOFT_BREAK)
            if cut < max_chars // 2:
                cut = max_chars
            out.append(part[: cut + 1])
            part = part[cut + 1 :].strip()
        if part:
            out.append(part)
    return out


class SpeechRequest(BaseModel):
    model: str = ""
    voice: str = "xiaobei"
    input: str
    response_format: str = "mp3"
    lang_code: str | None = None


def synthesize(text: str, voice: str) -> bytes:
    pcm = bytearray()
    for piece in split_sentences(text):
        for _, _, audio in pipeline(piece, voice=voice, speed=1.0):
            if torch.is_tensor(audio):
                audio = audio.detach().cpu().numpy()
            pcm += (np.asarray(audio) * 32768).astype("int16").tobytes()
    return bytes(pcm)


def wav_pcm16(pcm: bytes, rate: int) -> bytes:
    import wave

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm)
    return buffer.getvalue()


def to_mp3(wav: bytes) -> bytes:
    """Rakazo's self-hosted provider accepts MP3; ffmpeg does the conversion."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as source:
        source.write(wav)
        source_path = source.name
    try:
        done = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", source_path, "-f", "mp3", "pipe:1"],
            capture_output=True,
            check=True,
        )
        return done.stdout
    finally:
        os.unlink(source_path)


# Repeat listens (same text, same voice) replay instantly instead of paying
# for synthesis again.
CACHE_LIMIT = 128 * 1024 * 1024
_mp3_cache: OrderedDict[tuple[str, str], bytes] = OrderedDict()


def cached_mp3(voice: str, text: str, build) -> bytes:
    key = (voice, text)
    hit = _mp3_cache.get(key)
    if hit is not None:
        _mp3_cache.move_to_end(key)
        return hit
    value = build()
    _mp3_cache[key] = value
    total = sum(len(v) for v in _mp3_cache.values())
    while _mp3_cache and total > CACHE_LIMIT:
        _, dropped = _mp3_cache.popitem(last=False)
        total -= len(dropped)
    return value


@app.get("/v1/models")
async def models() -> dict:
    return {"data": [{"id": args.model, "object": "model"}]}


@app.get("/v1/audio/voices")
async def voices() -> dict:
    return {"voices": [{"id": key, "name": name} for key, name in VOICES.items()]}


@app.post("/v1/audio/speech")
async def speech(request: SpeechRequest) -> Response:
    voice = VOICES.get(request.voice.lower())
    if voice is None:
        raise HTTPException(status_code=400, detail=f"Unknown voice: {request.voice}")
    if not request.input.strip():
        raise HTTPException(status_code=400, detail="Nothing to speak.")
    if request.response_format != "mp3":
        raise HTTPException(status_code=400, detail="Only mp3 is supported.")

    def build() -> bytes:
        return to_mp3(wav_pcm16(synthesize(request.input, voice), SAMPLE_RATE))

    return Response(content=cached_mp3(voice, request.input, build), media_type="audio/mpeg")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
