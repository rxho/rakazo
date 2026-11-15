# Self-hosted voice on your own GPU

Two services give Rakazo calls a streaming recognizer and a natural speaking
voice, both on one card (an RTX 2080 Ti 22 GB runs both comfortably):

| Service | What it gives calls | Address to paste into Rakazo |
| --- | --- | --- |
| [FunASR runtime](./funasr) | live transcription while you speak | `ws://<gpu-host>:10095` |
| [Qwen3-TTS server](./qwen3-tts) | the bot's speaking voice | `http://<gpu-host>:8810/v1` |

## 1. Start the recogniser

```sh
cd funasr && docker compose up -d
# It downloads models on first start; watch: docker compose logs -f
```

## 2. Start the voice

```sh
cd qwen3-tts && docker compose up -d --build
# First start pulls the model from Hugging Face.
```

## 3. Point Rakazo at them

**Settings → Voice → Provider: Self-hosted**

- **Server URL** — `http://<gpu-host>:8810/v1` (the TTS server)
- **Speech model / Transcription model** — can stay empty; this server speaks,
  the recogniser below transcribes
- **Streaming recognition address** — `ws://<gpu-host>:10095`
- Pick a **Voice** (Cherry and Serena are Chinese-friendly), then **Connect**

The Rakazo server (your VM) must reach both addresses; your phone reaches only
the Rakazo server — audio relays through it, so no port besides the Rakazo
server's own needs to be public.

## What you should feel on a call

- Words appear as you speak, not after you stop.
- The bot starts talking on its first finished sentence, while it is still
  writing the rest.
- Talking over the reply cuts it off; talking while it works steers the task.

## Swapping the recogniser for Qwen3-ASR

Rakazo speaks the FunASR two-pass WebSocket protocol on its relay, and any
server that answers it works. To run Qwen3-ASR instead: host it behind vLLM,
wrap it in a small bridge that accepts the same frames (`{"mode":"2pass"...}`
start, binary 16 kHz PCM, `{"is_speaking":false}` end, and replies with
`{"mode":"2pass-online","text":...}` / `{"mode":"2pass-offline","text":...}`),
and paste that bridge's address instead. Nothing on the Rakazo side changes.

## Troubleshooting

- **"The speech server did not accept the recognition session."** — the address
  in Streaming recognition address is unreachable from the Rakazo VM, or the
  FunASR container is still loading models.
- **No voice on replies** — check the TTS server logs; the first request after
  boot takes longer while the model warms.
- **Calls still use the phone's own recognizer** — the account's default voice
  provider must be the Self-hosted one; the streaming recognizer rides the
  default provider's connection.
