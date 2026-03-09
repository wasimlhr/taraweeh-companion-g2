#!/usr/bin/env python3
"""
Test and compare quantized Whisper models
Tests both int8 and int4 on real Quran audio
"""

import torch
from transformers import WhisperProcessor, WhisperForConditionalGeneration
import librosa
import time
import os
import sys

def test_model(model_path, audio_file, model_name="Model"):
    """
    Test a single model and return results
    """
    print(f"\n{'='*70}")
    print(f"Testing: {model_name}")
    print(f"Path: {model_path}")
    print(f"{'='*70}")
    
    # Check if model exists
    if not os.path.exists(model_path):
        print(f"ERROR: Model not found at {model_path}")
        return None
    
    # Load processor
    print("Loading processor...")
    processor = WhisperProcessor.from_pretrained(model_path)
    
    # Load model
    print("Loading model...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Device: {device}")
    
    load_start = time.time()
    model = WhisperForConditionalGeneration.from_pretrained(
        model_path,
        device_map="auto",
        torch_dtype=torch.float16 if device == "cuda" else torch.float32
    )
    load_time = time.time() - load_start
    print(f"Model loaded in {load_time:.2f}s")
    
    # Load audio
    print(f"\nLoading audio: {audio_file}")
    if not os.path.exists(audio_file):
        print(f"ERROR: Audio file not found: {audio_file}")
        return None
        
    audio, sr = librosa.load(audio_file, sr=16000, duration=10)
    audio_duration = len(audio) / 16000
    print(f"Audio duration: {audio_duration:.2f}s")
    
    # Process audio
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
    input_features = inputs.input_features.to(model.device)
    
    # Warm-up run (first run is always slower)
    print("\nWarm-up run...")
    with torch.no_grad():
        _ = model.generate(
            input_features,
            language="ar",
            task="transcribe",
            max_new_tokens=50
        )
    
    # Actual test run
    print("\nTiming inference...")
    t0 = time.time()
    with torch.no_grad():
        predicted_ids = model.generate(
            input_features,
            language="ar",
            task="transcribe",
            max_new_tokens=448
        )
    inference_time = time.time() - t0
    
    # Decode transcription
    transcription = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
    
    # Results
    result = {
        'model_name': model_name,
        'model_path': model_path,
        'load_time': load_time,
        'inference_time': inference_time,
        'audio_duration': audio_duration,
        'rtf': inference_time / audio_duration,  # Real-time factor
        'transcription': transcription,
        'device': device
    }
    
    print(f"\n{'='*70}")
    print(f"RESULTS - {model_name}")
    print(f"{'='*70}")
    print(f"Load time:      {load_time:.2f}s")
    print(f"Inference time: {inference_time:.2f}s")
    print(f"Audio duration: {audio_duration:.2f}s")
    print(f"Real-time factor: {result['rtf']:.2f}x (lower is better)")
    print(f"\nTranscription:\n{transcription}")
    print(f"{'='*70}")
    
    return result

def compare_models(results):
    """
    Compare results from multiple models
    """
    if not results or len(results) < 2:
        return
    
    print(f"\n\n{'#'*70}")
    print(f"COMPARISON")
    print(f"{'#'*70}\n")
    
    # Table header
    print(f"{'Model':<20} {'Load (s)':<12} {'Inference (s)':<15} {'RTF':<8} {'Device':<10}")
    print(f"{'-'*70}")
    
    for r in results:
        if r:
            print(f"{r['model_name']:<20} {r['load_time']:<12.2f} {r['inference_time']:<15.2f} {r['rtf']:<8.2f} {r['device']:<10}")
    
    # Speedup comparison
    if len(results) >= 2 and results[0] and results[1]:
        base = results[0]
        for r in results[1:]:
            if r:
                speedup = (base['inference_time'] / r['inference_time']) * 100
                print(f"\n{r['model_name']} is {speedup:.1f}% the speed of {base['model_name']}")
                if speedup > 100:
                    print(f"  = {speedup - 100:.1f}% FASTER")
                else:
                    print(f"  = {100 - speedup:.1f}% SLOWER")
    
    # Transcription comparison
    print(f"\n{'='*70}")
    print("TRANSCRIPTION COMPARISON")
    print(f"{'='*70}")
    
    base_text = results[0]['transcription'] if results[0] else ""
    for i, r in enumerate(results):
        if r:
            print(f"\n{r['model_name']}:")
            print(f"  {r['transcription']}")
            
            if i > 0 and base_text:
                # Simple character-level similarity
                matches = sum(c1 == c2 for c1, c2 in zip(base_text, r['transcription']))
                max_len = max(len(base_text), len(r['transcription']))
                similarity = (matches / max_len * 100) if max_len > 0 else 0
                print(f"  Similarity to {results[0]['model_name']}: {similarity:.1f}%")

if __name__ == "__main__":
    # Configuration
    BASE_PATH = "D:\\G2_DEV\\QuranLiveMeaning\\training"
    
    models = [
        (f"{BASE_PATH}\\whisper-quran-v1-int8", "int8 (1.5GB)"),
        (f"{BASE_PATH}\\whisper-quran-v1-int4", "int4 (867MB)"),
    ]
    
    # Get audio file from command line or use default
    if len(sys.argv) > 1:
        audio_file = sys.argv[1]
    else:
        # You need to provide a test audio file!
        audio_file = input("Enter path to test Quran audio file (.wav or .mp3): ").strip()
    
    if not os.path.exists(audio_file):
        print(f"ERROR: Audio file not found: {audio_file}")
        print("\nUsage: python test_quantized_models.py <path_to_audio.wav>")
        sys.exit(1)
    
    # Check CUDA
    print(f"\n{'='*70}")
    print("SYSTEM INFO")
    print(f"{'='*70}")
    print(f"PyTorch version: {torch.__version__}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"CUDA device: {torch.cuda.get_device_name(0)}")
        print(f"CUDA version: {torch.version.cuda}")
    else:
        print("WARNING: Running on CPU - inference will be MUCH slower!")
        print("Install CUDA-enabled PyTorch for GPU acceleration.")
    
    # Test each model
    results = []
    for model_path, model_name in models:
        result = test_model(model_path, audio_file, model_name)
        results.append(result)
        
        # Clean up GPU memory between tests
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    
    # Compare results
    compare_models(results)
    
    # Recommendation
    print(f"\n\n{'='*70}")
    print("RECOMMENDATION")
    print(f"{'='*70}")
    
    if results[0] and results[1]:
        int8_rtf = results[0]['rtf']
        int4_rtf = results[1]['rtf']
        
        print(f"\nFor HuggingFace Endpoint (GPU):")
        if int4_rtf < 0.5 and results[1]['transcription'] == results[0]['transcription']:
            print(f"  -> Use int4 (867MB) - Fastest, same accuracy")
            print(f"     Expected latency: {int4_rtf * 5:.1f}s for 5s audio")
        elif int8_rtf < 1.0:
            print(f"  -> Use int8 (1.5GB) - Good balance")
            print(f"     Expected latency: {int8_rtf * 5:.1f}s for 5s audio")
        else:
            print(f"  -> Test results suggest models need GPU for good performance")
        
        print(f"\nAccuracy check:")
        if results[0]['transcription'] == results[1]['transcription']:
            print(f"  -> int4 and int8 produce IDENTICAL output")
            print(f"  -> Safe to use int4 (faster + smaller)")
        else:
            print(f"  -> Transcriptions differ - review carefully")
            print(f"  -> Consider using int8 if accuracy matters more")
    
    print(f"\n{'='*70}\n")
