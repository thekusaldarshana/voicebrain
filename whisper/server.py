"""A small local speech-to-text server with the OpenAI transcription API shape.

    POST /v1/audio/transcriptions   multipart: file, model, language, prompt, response_format, temperature
    GET  /health

Runs faster-whisper on CPU. The voicebrain server talks to it over the private compose network, so audio never
leaves your machine. Nothing here is published to the internet.
"""
import os
import tempfile
import threading
import time

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small.en")
THREADS = int(os.environ.get("WHISPER_THREADS", os.cpu_count() or 4))
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
API_KEY = os.environ.get("WHISPER_API_KEY", "")
MAX_BYTES = int(os.environ.get("WHISPER_MAX_MB", "200")) * 1024 * 1024

started = time.time()
model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE, cpu_threads=THREADS, download_root=os.environ.get("WHISPER_CACHE", "/models"))
lock = threading.Lock()  # the CPU is the bottleneck: one recording at a time
app = FastAPI(title="whisper")


def authorize(authorization: str = Header(default="")) -> None:
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "threads": THREADS, "compute": COMPUTE, "uptime": round(time.time() - started)}


@app.post("/v1/audio/transcriptions", dependencies=[Depends(authorize)])
def transcribe(
    file: UploadFile = File(...),
    model_name: str = Form("", alias="model"),  # accepted for compatibility; the loaded model is always used
    language: str = Form(""),
    prompt: str = Form(""),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
):
    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(file.filename or "")[1] or ".audio") as upload:
        size = 0
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                raise HTTPException(status_code=413, detail="file too large")
            upload.write(chunk)
        upload.flush()
        if size == 0:
            raise HTTPException(status_code=400, detail="empty file")
        try:
            with lock:
                segments, info = model.transcribe(
                    upload.name,
                    language=language or None,
                    initial_prompt=prompt or None,
                    temperature=temperature,
                    beam_size=5,
                    vad_filter=True,  # skip silence instead of inventing words over it
                    condition_on_previous_text=False,  # stops one bad stretch from derailing the rest
                )
                rows = [
                    {"id": index, "start": round(s.start, 2), "end": round(s.end, 2), "text": s.text, "avg_logprob": s.avg_logprob, "no_speech_prob": s.no_speech_prob}
                    for index, s in enumerate(segments)
                ]
        except Exception as error:  # undecodable audio is the caller's problem, not a server fault
            raise HTTPException(status_code=422, detail=f"could not read the audio: {error}")
    text = " ".join(row["text"].strip() for row in rows).strip()
    if response_format == "text":
        return text
    body = {"text": text}
    if response_format == "verbose_json":
        body |= {"task": "transcribe", "language": info.language, "duration": round(info.duration, 2), "model": MODEL, "segments": rows}
    return body
