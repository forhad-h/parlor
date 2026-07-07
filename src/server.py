"""Parlor — real-time multimodal AI (voice + vision).

Two run modes, selected by NODE_SERVICE_URL (see below):

- Hosted / Bengali (default): the LLM + TTS run in the Node sidecar
  (`service/`); this process skips the on-device models and relays turns.
- On-device (opt-in): the original upstream path — Gemma 4 E2B + Kokoro,
  all local. Enable it by setting NODE_SERVICE_URL= (empty) in .env.

The browser WebSocket contract is byte-for-byte identical in both modes.
"""

import asyncio
import base64
import json
import os
import re
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, Response

import tts

from dotenv import load_dotenv
load_dotenv()

# Hosted (Bengali) mode is the default: with no configuration this points at the
# Node sidecar and the on-device models are never downloaded or loaded. Set
# NODE_SERVICE_URL= (empty) to opt into the original on-device English path.
NODE_SERVICE_URL = os.environ.get("NODE_SERVICE_URL", "http://localhost:3001").rstrip("/")
HOSTED_MODE = bool(NODE_SERVICE_URL)

# Shown (in Bengali) if the Node service hard-fails, so a failed turn degrades
# to a friendly text message instead of a hung WebSocket. Mirrors service/src/errors.js.
BENGALI_ERROR_MESSAGE = (
    "দুঃখিত, এই মুহূর্তে আমি উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করুন।"
)

HF_REPO = "litert-community/gemma-4-E2B-it-litert-lm"
HF_FILENAME = "gemma-4-E2B-it.litertlm"


def resolve_model_path() -> str:
    path = os.environ.get("MODEL_PATH", "")
    if path:
        return path
    from huggingface_hub import hf_hub_download
    print(f"Downloading {HF_REPO}/{HF_FILENAME} (first run only)...")
    return hf_hub_download(repo_id=HF_REPO, filename=HF_FILENAME)


# Only resolve/download the ~2.6 GB model when we actually run it on-device.
MODEL_PATH = "" if HOSTED_MODE else resolve_model_path()
SYSTEM_PROMPT = (
    "You are a friendly, conversational AI assistant. The user is talking to you "
    "through a microphone and showing you their camera. "
    "You MUST always use the respond_to_user tool to reply. "
    "First transcribe exactly what the user said, then write your response."
)

SENTENCE_SPLIT_RE = re.compile(r'(?<=[.!?])\s+')

engine = None
tts_backend = None
http_client = None


def check_node_service():
    """Best-effort startup check for the Node sidecar.

    A missing/misconfigured API key makes the Node service refuse to start (it
    fails fast in config.js), and an unstarted Node service is the most common
    first-run mistake now that hosted mode is the default. Both look identical
    from here (connection refused), so warn about both rather than let it
    surface as a silent per-turn Bengali apology later.
    """
    try:
        httpx.get(f"{NODE_SERVICE_URL}/health", timeout=2.0).raise_for_status()
    except Exception:
        prefix = "\033[1;33mWarning\033[0m" if sys.stderr.isatty() else "Warning"
        print(
            f"\n{prefix}: can't reach the Node service at {NODE_SERVICE_URL}.\n"
            "Bengali mode needs it running with a valid API key:\n"
            "  cd service && npm install && cp .env.example .env   # add GEMINI_API_KEY\n"
            "  npm start\n"
            "  (or key-free: LLM_PROVIDER=mock npm start)\n"
            "See the \"Quick start\" section of README.md for details.\n",
            file=sys.stderr,
        )


def load_models():
    global engine, tts_backend
    if HOSTED_MODE:
        print(f"Hosted mode: LLM + TTS handled by Node service at {NODE_SERVICE_URL}")
        print("Skipping on-device Gemma 4 E2B + Kokoro load.")
        check_node_service()
        return

    # Imported lazily so hosted mode has no hard dependency on the on-device stack.
    import litert_lm

    print(f"Loading Gemma 4 E2B from {MODEL_PATH}...")
    engine = litert_lm.Engine(
        MODEL_PATH,
        backend=litert_lm.Backend.GPU,
        vision_backend=litert_lm.Backend.GPU,
        audio_backend=litert_lm.Backend.CPU,
    )
    engine.__enter__()
    print("Engine loaded.")

    try:
        tts_backend = tts.load()
    except RuntimeError as e:
        # Fatal setup error (e.g. missing espeak-ng) — print just the
        # actionable message, not a stack trace through asyncio/starlette.
        prefix = "\033[1;31mError\033[0m" if sys.stderr.isatty() else "Error"
        print(f"\n{prefix}: TTS setup failed\n{e}\n", file=sys.stderr)
        os._exit(1)


@asynccontextmanager
async def lifespan(app):
    global http_client
    await asyncio.get_event_loop().run_in_executor(None, load_models)
    if HOSTED_MODE:
        # Shared client → connection pooling across turns. Generous timeout:
        # a turn is LLM + concurrent TTS on the Node side.
        http_client = httpx.AsyncClient(timeout=httpx.Timeout(90.0))
    yield
    if http_client is not None:
        await http_client.aclose()


app = FastAPI(lifespan=lifespan)


def split_sentences(text: str) -> list[str]:
    """Split text into sentences for streaming TTS."""
    parts = SENTENCE_SPLIT_RE.split(text.strip())
    return [s.strip() for s in parts if s.strip()]


@app.get("/")
async def root():
    return HTMLResponse(content=(Path(__file__).parent / "index.html").read_text())


async def live_model_label_script() -> str:
    """A `window.STRINGS.modelLabel` override reflecting the Node service's
    actual configured provider/model, appended after the static Bengali
    strings so the UI never shows a stale hardcoded name. Best-effort: on any
    failure (Node unreachable, slow), the static file's default label stands.
    """
    try:
        resp = await http_client.get(f"{NODE_SERVICE_URL}/health", timeout=2.0)
        resp.raise_for_status()
        data = resp.json()
        label = f"{data['llmModelLabel']} · {data['ttsProviderLabel']} TTS"
        return f"\nwindow.STRINGS.modelLabel = {json.dumps(label)};\n"
    except Exception:
        return ""


@app.get("/strings.js")
async def strings_js():
    # index.html always requests this one path; which language file backs it
    # depends on the run mode so the UI matches whichever backend is serving
    # turns (English on-device, Bengali hosted).
    if not HOSTED_MODE:
        return FileResponse(
            Path(__file__).parent / "strings.en.js", media_type="application/javascript"
        )

    # read_text() off the event loop thread, to match the FileResponse branch
    # above (which streams via a thread pool). Tradeoff: still re-reads the
    # file on every request rather than caching it in memory — acceptable
    # here since this is dev-server-scale traffic (one request per page load)
    # and it keeps edits to strings.bn.js visible without a restart.
    content = await anyio.to_thread.run_sync(
        lambda: (Path(__file__).parent / "strings.bn.js").read_text()
    )
    content += await live_model_label_script()
    return Response(content=content, media_type="application/javascript")


async def process_turn_hosted(ws: WebSocket, session_id: str, interrupted: asyncio.Event, msg: dict):
    """One turn via the Node service, relayed into the existing WS frames.

    Barge-in is when the user starts speaking again before the assistant
    finishes; that sets the `interrupted` event. We consume the Node response as
    a stream (NDJSON — one event per line) and relay each event into the browser
    WS frames as it arrives, so the first sentence's audio plays while later
    sentences are still being synthesized (progressive playback across the
    network hop). Every line-read races the `interrupted` event: on a barge-in we
    stop reading and let the stream context close the connection, which Node
    detects (res.on('close')) and uses to stop synthesizing the rest of the turn.
    So — unlike a plain request/response — in-flight TTS work is actually
    cancelled cross-process, not just discarded locally.

    One residual limitation: Node's `/converse` handler saves the user+model turn
    to session history (see appendTurn in converse.js) as soon as its LLM call
    returns, *before* it knows whether the client later interrupted. So an
    interrupted turn the user never actually heard can still end up in the
    conversation history Node uses for the *next* turn's context — a discarded
    reply can silently influence what the assistant says afterward. (The LLM leg
    also still runs to completion on an early barge-in: Node emits nothing until
    the reply text is ready, so only the TTS leg is cancellable mid-turn.)
    """
    payload = {"sessionId": session_id}
    if msg.get("audio"):
        payload["audioBase64"] = msg["audio"]
    if msg.get("image"):
        payload["imageBase64"] = msg["image"]
    if msg.get("text"):
        payload["text"] = msg["text"]

    chunk_count = 0
    try:
        async with http_client.stream(
            "POST", f"{NODE_SERVICE_URL}/converse", json=payload
        ) as resp:
            # Pre-stream failure: Node returns a normal non-200 JSON error (the
            # status/headers arrive before any event line) carrying a Bengali
            # apology for us to speak.
            if resp.status_code != 200:
                bengali = BENGALI_ERROR_MESSAGE
                try:
                    body = await resp.aread()
                    bengali = json.loads(body).get("bengaliMessage") or bengali
                except Exception:
                    pass
                print(f"Node service error: HTTP {resp.status_code}", file=sys.stderr)
                await ws.send_text(json.dumps({"type": "text", "text": bengali, "llm_time": 0}))
                return

            # Relay each NDJSON event as it arrives. Race every line-read against
            # the interrupt event so a barge-in stops us promptly; leaving the
            # `async with` then closes the connection, which Node uses to cancel
            # the rest of the TTS work.
            line_iter = resp.aiter_lines()
            interrupt_task = asyncio.ensure_future(interrupted.wait())
            try:
                while True:
                    next_task = asyncio.ensure_future(line_iter.__anext__())
                    done, _ = await asyncio.wait(
                        {next_task, interrupt_task}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if interrupt_task in done:
                        next_task.cancel()
                        print("Interrupted during stream, closing connection")
                        break
                    try:
                        line = next_task.result()
                    except StopAsyncIteration:
                        break
                    if not line:
                        continue

                    event = json.loads(line)
                    etype = event.get("type")

                    if etype == "text":
                        text_response = event.get("responseText", "")
                        transcription = event.get("transcription")
                        llm_time = round(event.get("llmMs", 0) / 1000, 2)
                        print(f"LLM ({llm_time:.2f}s) [node] heard: {transcription!r} → {text_response}")
                        reply = {"type": "text", "text": text_response, "llm_time": llm_time}
                        if transcription:
                            reply["transcription"] = transcription
                        await ws.send_text(json.dumps(reply))
                    elif etype == "audio_start":
                        await ws.send_text(json.dumps({
                            "type": "audio_start",
                            "sample_rate": event.get("sampleRate", 24000),
                            "sentence_count": event.get("sentenceCount", 0),
                        }))
                    elif etype == "audio_chunk":
                        chunk_count += 1
                        await ws.send_text(json.dumps({
                            "type": "audio_chunk",
                            "audio": event.get("audioBase64"),
                            "index": event.get("index"),
                        }))
                    elif etype == "done":
                        tts_time = round(event.get("ttsMs", 0) / 1000, 2)
                        print(f"TTS ({tts_time:.2f}s): {chunk_count} chunks")
                        await ws.send_text(json.dumps({"type": "audio_end", "tts_time": tts_time}))
                    elif etype == "error":
                        # Mid-stream failure (headers already sent, so it arrives
                        # as an event, not a non-200): speak the apology and stop.
                        bengali = event.get("bengaliMessage") or BENGALI_ERROR_MESSAGE
                        print("Node stream error event", file=sys.stderr)
                        await ws.send_text(json.dumps({"type": "text", "text": bengali, "llm_time": 0}))
                        break
            finally:
                interrupt_task.cancel()
    except Exception as e:
        # A barge-in cancels the in-flight read; that's expected, not an error.
        if not interrupted.is_set():
            print(f"Node service error: {e}", file=sys.stderr)
            await ws.send_text(json.dumps({"type": "text", "text": BENGALI_ERROR_MESSAGE, "llm_time": 0}))


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    # Local mode keeps per-connection LLM state in `conversation`; hosted mode
    # keys the Node service's history on this sessionId instead.
    session_id = uuid.uuid4().hex
    conversation = None

    # Per-connection tool state captured via closure
    tool_result = {}

    if not HOSTED_MODE:
        def respond_to_user(transcription: str, response: str) -> str:
            """Respond to the user's voice message.

            Args:
                transcription: Exact transcription of what the user said in the audio.
                response: Your conversational response to the user. Keep it to 1-4 short sentences.
            """
            tool_result["transcription"] = transcription
            tool_result["response"] = response
            return "OK"

        conversation = engine.create_conversation(
            messages=[{"role": "system", "content": SYSTEM_PROMPT}],
            tools=[respond_to_user],
        )
        conversation.__enter__()

    interrupted = asyncio.Event()
    msg_queue = asyncio.Queue()

    async def receiver():
        """Receive messages from WebSocket and route them."""
        try:
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                if msg.get("type") == "interrupt":
                    interrupted.set()
                    print("Client interrupted")
                else:
                    await msg_queue.put(msg)
        except WebSocketDisconnect:
            await msg_queue.put(None)

    recv_task = asyncio.create_task(receiver())

    try:
        while True:
            msg = await msg_queue.get()
            if msg is None:
                break

            interrupted.clear()

            if HOSTED_MODE:
                await process_turn_hosted(ws, session_id, interrupted, msg)
                continue

            content = []
            if msg.get("audio"):
                content.append({"type": "audio", "blob": msg["audio"]})
            if msg.get("image"):
                content.append({"type": "image", "blob": msg["image"]})

            if msg.get("audio") and msg.get("image"):
                content.append({"type": "text", "text": "The user just spoke to you (audio) while showing their camera (image). Respond to what they said, referencing what you see if relevant."})
            elif msg.get("audio"):
                content.append({"type": "text", "text": "The user just spoke to you. Respond to what they said."})
            elif msg.get("image"):
                content.append({"type": "text", "text": "The user is showing you their camera. Describe what you see."})
            else:
                content.append({"type": "text", "text": msg.get("text", "Hello!")})

            # LLM inference
            t0 = time.time()
            tool_result.clear()
            response = await asyncio.get_event_loop().run_in_executor(
                None, lambda: conversation.send_message({"role": "user", "content": content})
            )
            llm_time = time.time() - t0

            # Extract response from tool call or fallback to raw text
            if tool_result:
                strip = lambda s: s.replace('<|"|>', "").strip()
                transcription = strip(tool_result.get("transcription", ""))
                text_response = strip(tool_result.get("response", ""))
                print(f"LLM ({llm_time:.2f}s) [tool] heard: {transcription!r} → {text_response}")
            else:
                transcription = None
                text_response = response["content"][0]["text"]
                print(f"LLM ({llm_time:.2f}s) [no tool]: {text_response}")

            if interrupted.is_set():
                print("Interrupted after LLM, skipping response")
                continue

            reply = {"type": "text", "text": text_response, "llm_time": round(llm_time, 2)}
            if transcription:
                reply["transcription"] = transcription
            await ws.send_text(json.dumps(reply))

            if interrupted.is_set():
                print("Interrupted before TTS, skipping audio")
                continue

            # Streaming TTS: split into sentences and send chunks progressively
            sentences = split_sentences(text_response)
            if not sentences:
                sentences = [text_response]

            tts_start = time.time()

            # Signal start of audio stream
            await ws.send_text(json.dumps({
                "type": "audio_start",
                "sample_rate": tts_backend.sample_rate,
                "sentence_count": len(sentences),
            }))

            for i, sentence in enumerate(sentences):
                if interrupted.is_set():
                    print(f"Interrupted during TTS (sentence {i+1}/{len(sentences)})")
                    break

                # Generate audio for this sentence
                pcm = await asyncio.get_event_loop().run_in_executor(
                    None, lambda s=sentence: tts_backend.generate(s)
                )

                if interrupted.is_set():
                    break

                # Convert to 16-bit PCM and send as base64
                pcm_int16 = (pcm * 32767).clip(-32768, 32767).astype(np.int16)
                await ws.send_text(json.dumps({
                    "type": "audio_chunk",
                    "audio": base64.b64encode(pcm_int16.tobytes()).decode(),
                    "index": i,
                }))

            tts_time = time.time() - tts_start
            print(f"TTS ({tts_time:.2f}s): {len(sentences)} sentences")

            if not interrupted.is_set():
                await ws.send_text(json.dumps({
                    "type": "audio_end",
                    "tts_time": round(tts_time, 2),
                }))

    except WebSocketDisconnect:
        print("Client disconnected")
    finally:
        recv_task.cancel()
        if conversation is not None:
            conversation.__exit__(None, None, None)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
