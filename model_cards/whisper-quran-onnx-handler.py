# HuggingFace Inference Endpoint handler for wasimlhr/whisper-quran-v1-onnx-quantized
# Uses ONNX when decoder_with_past is present; falls back to PyTorch fp16 (wasimlhr/whisper-quran-v1) otherwise.

import base64
import io
import logging
from typing import Any, Dict

# Suppress "Whisper did not predict an ending timestamp" debug log (expected when audio ends mid-word)
logging.getLogger("transformers.models.whisper.generation_whisper").setLevel(logging.INFO)

from transformers import WhisperProcessor, pipeline


# Fallback PyTorch model when ONNX export is missing decoder_with_past (needed for generation)
FALLBACK_MODEL_ID = "wasimlhr/whisper-quran-v1"
# Model max_length is 448; decoder_input_ids has 3 prompt tokens, so max_new_tokens must be <= 445
MAX_NEW_TOKENS = 445


class EndpointHandler:
    def __init__(self, path: str = ""):
        self._use_onnx = False
        try:
            from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
            try:
                model = ORTModelForSpeechSeq2Seq.from_pretrained(
                    path,
                    provider="CUDAExecutionProvider",
                )
            except Exception:
                model = ORTModelForSpeechSeq2Seq.from_pretrained(
                    path,
                    provider="CPUExecutionProvider",
                )
            self._use_onnx = True
        except FileNotFoundError:
            # Missing decoder_with_past_model.onnx — use PyTorch fp16 from Hub
            import torch
            from transformers import WhisperForConditionalGeneration
            model = WhisperForConditionalGeneration.from_pretrained(
                FALLBACK_MODEL_ID,
                torch_dtype=torch.float16,
                device_map="auto",
            )
            model.eval()
        except Exception:
            import torch
            from transformers import WhisperForConditionalGeneration
            model = WhisperForConditionalGeneration.from_pretrained(
                FALLBACK_MODEL_ID,
                torch_dtype=torch.float16,
                device_map="auto",
            )
            model.eval()

        self.processor = WhisperProcessor.from_pretrained(path)
        # Do not pass device when model uses device_map="auto" (accelerate); pipeline uses model's device
        self.pipeline = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=self.processor.tokenizer,
            feature_extractor=self.processor.feature_extractor,
        )

    def __call__(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        data["inputs"]: base64-encoded audio (str) or raw bytes
        data["parameters"]: optional {"return_timestamps": true, "language": "ar", "task": "transcribe"}
        Returns: {"text": "...", "chunks": [{"text": "word", "start": 0.0, "end": 0.5}, ...]} — chunks are word-level (one entry per word).
        """
        import librosa

        inputs = data.pop("inputs", None)
        if inputs is None:
            return {"text": "", "chunks": [], "error": "Missing 'inputs' (base64 audio)"}

        parameters = data.pop("parameters", {}) or {}
        return_timestamps = parameters.get("return_timestamps", True)
        language = parameters.get("language", "ar")
        task = parameters.get("task", "transcribe")

        if isinstance(inputs, str):
            raw = base64.b64decode(inputs)
        elif isinstance(inputs, bytes):
            raw = inputs
        else:
            return {"text": "", "chunks": [], "error": "inputs must be base64 string or bytes"}

        if not raw:
            return {"text": "", "chunks": [], "error": "Empty audio"}

        audio, sr = librosa.load(io.BytesIO(raw), sr=16000, mono=True)

        if return_timestamps:
            # num_frames needed for accurate word-level timestamps (Whisper hop_length = 160)
            hop_length = getattr(
                self.processor.feature_extractor, "hop_length", 160
            )
            num_frames = int(len(audio) / hop_length)
            out = self.pipeline(
                {"array": audio, "sampling_rate": 16000},
                return_timestamps="word",
                generate_kwargs={
                    "language": language,
                    "task": task,
                    "max_new_tokens": MAX_NEW_TOKENS,
                    "num_frames": num_frames,
                },
            )
            text = (out.get("text") or "").strip()
            chunks_raw = out.get("chunks") or []
            chunks = []
            for c in chunks_raw:
                ts = c.get("timestamp")
                start, end = None, None
                if isinstance(ts, (list, tuple)) and len(ts) >= 2:
                    try:
                        start = round(float(ts[0]), 2) if ts[0] is not None else None
                    except (TypeError, ValueError):
                        pass
                    try:
                        end = round(float(ts[1]), 2) if ts[1] is not None else None
                    except (TypeError, ValueError):
                        pass
                chunks.append({
                    "text": (c.get("text") or "").strip(),
                    "start": start,
                    "end": end,
                })
            # chunks = word-level (one entry per word); expose as "words" too for clarity
            return {"text": text, "chunks": chunks, "words": chunks}

        out = self.pipeline(
            {"array": audio, "sampling_rate": 16000},
            generate_kwargs={"language": language, "task": task, "max_new_tokens": MAX_NEW_TOKENS},
        )
        text = (out.get("text") or "").strip()
        return {"text": text, "chunks": []}
