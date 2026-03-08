"""
Modal app: Whisper Quran int4 — HTTP API for Quran transcription.
Deploy: modal deploy app.py
Serve locally: modal serve app.py
"""

import modal

app = modal.App("whisper-quran-int4")

# GPU image: transformers, torch, librosa, bitsandbytes (required to load quantized model config)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch>=2.0",
        "transformers>=4.40",
        "accelerate",
        "bitsandbytes>=0.46.1",
        "librosa",
        "soundfile",
    )
)


@app.function(
    image=image,
    gpu="T4",
    timeout=120,
    allow_concurrent_inputs=4,
)
@modal.asgi_app()
def web():
    """Single ASGI app: GET / = model card, POST / = transcribe WAV -> JSON with optional timestamps."""
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    api = FastAPI(
        title="Whisper Quran int4",
        description="Transcribe Quran recitation audio (WAV) to Arabic text. Model: wasimlhr/whisper-quran-v1-int4",
    )

    @api.get("/")
    def card():
        """Model card: info for dashboard / health."""
        from handler import get_model_card
        return get_model_card()

    @api.post("/")
    async def transcribe_route(request: Request):
        """
        Transcribe WAV: POST body = raw WAV bytes.
        Query: ?language=ar&task=transcribe&return_timestamps=true (default).
        Returns: {"text": "...", "chunks": [{"text": "word", "start": 0.0, "end": 0.5}, ...]}
        """
        body = await request.body()
        if not body or len(body) == 0:
            return JSONResponse(
                content={"error": "Empty body", "text": "", "chunks": []},
                status_code=400,
            )
        language = request.query_params.get("language", "ar")
        task = request.query_params.get("task", "transcribe")
        return_ts = request.query_params.get("return_timestamps", "true").lower() in ("1", "true", "yes")
        try:
            from handler import transcribe
            result = transcribe(bytes(body), language=language, task=task, return_timestamps=return_ts)
            return result
        except Exception as e:
            return JSONResponse(
                content={"error": str(e), "text": "", "chunks": []},
                status_code=500,
            )

    return api
