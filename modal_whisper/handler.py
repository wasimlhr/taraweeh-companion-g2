"""
Whisper Quran int8 inference handler for Modal.
Loads wasimlhr/whisper-quran-v1-int8 and transcribes WAV audio to Arabic text with optional word-level timestamps.
"""

import io
import torch
from transformers import WhisperProcessor, WhisperForConditionalGeneration, pipeline

# Model ID on HuggingFace (quantized int8)
MODEL_ID = "wasimlhr/whisper-quran-v1-int8"
LANGUAGE = "ar"
TASK = "transcribe"

_processor = None
_model = None
_pipe = None


def get_model():
    """Load model and processor once (reused across requests)."""
    global _processor, _model
    if _model is not None:
        return _processor, _model
    _processor = WhisperProcessor.from_pretrained(MODEL_ID)
    _model = WhisperForConditionalGeneration.from_pretrained(
        MODEL_ID,
        device_map="auto",
        torch_dtype=torch.float16,
    )
    _model.eval()
    return _processor, _model


def get_pipeline():
    """Build ASR pipeline once (for word-level timestamps)."""
    global _pipe
    if _pipe is not None:
        return _pipe
    processor, model = get_model()
    _pipe = pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        device=0 if torch.cuda.is_available() else -1,
    )
    return _pipe


def transcribe(
    wav_bytes: bytes,
    language: str = LANGUAGE,
    task: str = TASK,
    return_timestamps: bool = True,
) -> dict:
    """
    Transcribe WAV audio bytes to text.
    If return_timestamps is True, returns dict with "text" and "chunks" (word-level timestamps).
    Chunks are [{"text": "word", "start": s, "end": e}, ...] with times in seconds.
    """
    import librosa

    audio, sr = librosa.load(io.BytesIO(wav_bytes), sr=16000, mono=True)

    if return_timestamps:
        pipe = get_pipeline()
        out = pipe(
            {"array": audio, "sampling_rate": 16000},
            return_timestamps="word",
            generate_kwargs={"language": language, "task": task, "max_new_tokens": 448},
        )
        text = out.get("text", "") or ""
        chunks_raw = out.get("chunks") or []
        chunks = []
        for c in chunks_raw:
            ts = c.get("timestamp")
            if isinstance(ts, (list, tuple)) and len(ts) >= 2:
                chunks.append({
                    "text": (c.get("text") or "").strip(),
                    "start": round(float(ts[0]), 2),
                    "end": round(float(ts[1]), 2),
                })
            else:
                chunks.append({"text": (c.get("text") or "").strip(), "start": None, "end": None})
        return {"text": text.strip(), "chunks": chunks}

    # No timestamps: use generate directly (slightly lighter)
    processor, model = get_model()
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
    input_features = inputs.input_features.to(model.device, dtype=model.dtype)
    with torch.no_grad():
        predicted_ids = model.generate(
            input_features,
            language=language,
            task=task,
            max_new_tokens=448,
        )
    text = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
    return {"text": (text or "").strip(), "chunks": []}


def get_model_card() -> dict:
    """Return model card info for GET / (dashboard card)."""
    return {
        "model": MODEL_ID,
        "description": "Whisper Large V3 fine-tuned for Quran recitation (int8 quantized)",
        "language": LANGUAGE,
        "task": TASK,
        "quantization": "int8",
        "use_case": "Quran ayah transcription",
        "timestamps": "word",
    }
