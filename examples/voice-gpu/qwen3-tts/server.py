"""
OpenAI-compatible speech server for Qwen3-TTS, for Rakazo's Self-hosted voice.

Endpoints (what Rakazo's `openai-compatible` voice provider calls):
  GET  /v1/models            – proves reachability
  GET  /v1/audio/voices      – lists the voices this server offers
  POST /v1/audio/speech      – {model, voice, input, response_format:"mp3"} -> MP3 bytes

Qwen3-TTS loads through its own `qwen-tts` package; transformers' AutoModel
does not know the `qwen3_tts` architecture. Turing note (RTX 2080 Ti and
friends): the model is trained in bf16 and the card has neither bf16 nor
enough fp16 headroom (fp16 logits overflow to inf/nan and trip CUDA's
sampling assert), so float32 it is; flash-attention needs sm80+, hence
sdpa. Adjust MODEL_CALL below if qwen-tts renames its API — the rest of the
server stays as is.
"""

from __future__ import annotations

import argparse
import io
import os
import subprocess
import tempfile
from collections import OrderedDict

import torch
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel
from qwen_tts import Qwen3TTSModel

DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
# The bundled custom voices; keys map to the /v1/audio/voices ids.
VOICES = {
    "vivian": "Vivian",
    "serena": "Serena",
    "uncle_fu": "Uncle_Fu",
    "dylan": "Dylan",
    "eric": "Eric",
    "ryan": "Ryan",
    "aiden": "Aiden",
    "ono_anna": "Ono_Anna",
    "sohee": "Sohee",
}
LANGS = {
    "zh": "Chinese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "ru": "Russian",
    "pt": "Portuguese",
    "es": "Spanish",
    "it": "Italian",
}

parser = argparse.ArgumentParser()
parser.add_argument("--model", default=os.environ.get("TTS_MODEL", DEFAULT_MODEL))
parser.add_argument("--dtype", default=os.environ.get("TTS_DTYPE", "float32"))
parser.add_argument("--device", default=os.environ.get("TTS_DEVICE", "cuda"))
parser.add_argument("--host", default="0.0.0.0")
parser.add_argument("--port", type=int, default=8810)
args, _ = parser.parse_known_args()

app = FastAPI()
model = Qwen3TTSModel.from_pretrained(
    args.model,
    device_map=args.device,
    dtype=getattr(torch, args.dtype),
    attn_implementation="sdpa",
)


class SpeechRequest(BaseModel):
    model: str = ""
    voice: str = "serena"
    input: str
    response_format: str = "mp3"
    lang_code: str | None = None


SENTENCE_END = "。！？.!?"
CJK_END = "。！？"
# Long unbroken Chinese runs keep listeners waiting; split at these too.
SOFT_BREAK = "，、；,;:"


def split_sentences(text: str, max_chars: int = 48) -> list[str]:
    """Splits on sentence enders, then at soft breaks when a piece is too long.

    Whole messages synthesize much faster as one batch of short pieces than as
    one long prompt (GPU decode length dominates), and Rakazo's self-hosted
    speak call sends whole messages.
    """
    parts: list[str] = []
    start = 0
    for i, ch in enumerate(text):
        if ch not in SENTENCE_END:
            continue
        nxt = text[i + 1] if i + 1 < len(text) else ""
        # CJK enders close a sentence outright; ASCII ones need a space after,
        # so decimals and abbreviations stay intact.
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


def synthesize(text: str, speaker: str, language: str) -> tuple[bytes, int]:
    """MODEL_CALL: the one line that tracks the official Qwen3-TTS example.

    Sentences go in as one batch; GPU decode cost tracks the longest piece,
    not the sum, so a whole message costs little more than its longest
    sentence.
    """
    pieces = split_sentences(text) or [text]
    try:
        wavs, sr = model.generate_custom_voice(
            text=pieces, language=language, speaker=speaker, instruct=None
        )
    except TypeError:
        # Older qwen-tts requires an instruct string; a neutral one keeps the
        # voice itself in charge.
        wavs, sr = model.generate_custom_voice(
            text=pieces,
            language=language,
            speaker=speaker,
            instruct="用自然平稳的语气说",
        )
    pcm = bytearray()
    for audio in wavs:
        if hasattr(audio, "detach"):  # torch tensor in some qwen-tts versions
            audio = audio.detach().cpu().numpy()
        pcm += (audio * 32768).astype("int16").tobytes()
    return bytes(pcm), sr


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
_mp3_cache: OrderedDict[tuple[str, str, str], bytes] = OrderedDict()


def cached_mp3(speaker: str, language: str, text: str, build) -> bytes:
    key = (speaker, language, text)
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
    speaker = VOICES.get(request.voice.lower())
    if speaker is None:
        raise HTTPException(status_code=400, detail=f"Unknown voice: {request.voice}")
    if not request.input.strip():
        raise HTTPException(status_code=400, detail="Nothing to speak.")
    if request.response_format != "mp3":
        raise HTTPException(status_code=400, detail="Only mp3 is supported.")
    language = LANGS.get((request.lang_code or "zh").lower(), "Chinese")

    def build() -> bytes:
        pcm, rate = synthesize(request.input, speaker, language)
        return to_mp3(wav_pcm16(pcm, rate))

    return Response(content=cached_mp3(speaker, language, request.input, build), media_type="audio/mpeg")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
