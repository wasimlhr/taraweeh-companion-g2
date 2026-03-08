"""
Modal Deployment for Whisper Quran V1 with Word Timestamps
Deploy: modal deploy modal_whisper_deploy.py
"""
import modal
import io

# Create Modal stub
stub = modal.Stub("whisper-quran-v1-timestamps")

# Define GPU image with Whisper dependencies
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "transformers>=4.30.0",  # Need 4.30+ for word timestamps
        "torch",
        "torchaudio", 
        "librosa",
        "soundfile",
        "accelerate"
    )
)

# Load model once on container startup
@stub.cls(
    image=image,
    gpu=modal.gpu.A10G(),  # Or A100, T4, etc.
    container_idle_timeout=300,  # Keep warm for 5 min
    timeout=60,
)
class WhisperQuranModel:
    def __enter__(self):
        from transformers import WhisperProcessor, WhisperForConditionalGeneration
        import torch
        
        MODEL_ID = "wasimlhr/whisper-quran-v1"
        
        print(f"Loading {MODEL_ID}...")
        self.processor = WhisperProcessor.from_pretrained(
            MODEL_ID, 
            language="ar", 
            task="transcribe"
        )
        self.model = WhisperForConditionalGeneration.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.float16
        ).to("cuda")
        self.model.eval()
        print(f"Model loaded!")
    
    @modal.method()
    def transcribe(self, audio_bytes: bytes):
        """Transcribe audio with word-level timestamps"""
        import soundfile as sf
        import librosa
        import numpy as np
        import torch
        
        # Load audio from bytes
        audio_data, sr = sf.read(io.BytesIO(audio_bytes))
        
        # Convert to mono if stereo
        if len(audio_data.shape) > 1:
            audio_data = audio_data.mean(axis=1)
        
        # Resample to 16kHz if needed
        if sr != 16000:
            audio_data = librosa.resample(audio_data, orig_sr=sr, target_sr=16000)
        
        # Process audio
        audio_data = audio_data.astype(np.float32)
        inputs = self.processor(
            audio_data, 
            sampling_rate=16000, 
            return_tensors="pt"
        )
        
        # Move to GPU
        input_features = inputs.input_features.to("cuda", dtype=torch.float16)
        
        # Generate with timestamps enabled
        with torch.no_grad():
            generated_ids = self.model.generate(
                input_features,
                language="ar",
                task="transcribe",
                max_new_tokens=448,
                return_timestamps=True  # ← KEY: Enable timestamps
            )
        
        # Decode with word-level timestamps
        result = self.processor.batch_decode(
            generated_ids,
            skip_special_tokens=True,
            return_timestamps='word'  # ← KEY: Request word-level
        )[0]
        
        # Format response
        text = result.get('text', '')
        words = []
        
        for chunk in result.get('chunks', []):
            words.append({
                "text": chunk['text'],
                "start": chunk['timestamp'][0],
                "end": chunk['timestamp'][1]
            })
        
        print(f"Transcribed: {len(words)} words")
        return {
            "text": text,
            "words": words
        }


# Web endpoint
@stub.function(image=image)
@modal.web_endpoint(method="POST")
def transcribe_endpoint(audio: bytes):
    """HTTP endpoint for transcription"""
    model = WhisperQuranModel()
    return model.transcribe.remote(audio)


# Test locally
@stub.local_entrypoint()
def test():
    """Test the deployment locally"""
    print("Testing Whisper model with word timestamps...")
    
    # Create test audio (1 second of silence)
    import numpy as np
    test_audio = np.zeros(16000, dtype=np.float32)
    
    import soundfile as sf
    import io
    buffer = io.BytesIO()
    sf.write(buffer, test_audio, 16000, format='WAV')
    buffer.seek(0)
    
    model = WhisperQuranModel()
    result = model.transcribe.remote(buffer.read())
    
    print("Result:", result)
    print(f"Text: {result['text']}")
    print(f"Words: {len(result['words'])}")
    
    if result['words']:
        print("\nFirst 3 words:")
        for w in result['words'][:3]:
            print(f"  '{w['text']}' from {w['start']:.2f}s to {w['end']:.2f}s")
