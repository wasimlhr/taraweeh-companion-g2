#!/bin/bash
# Test all three Whisper endpoints and compare latency

set -e

TOKEN="${HUGGINGFACE_TOKEN:-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}"

# Test audio file (you need to provide this)
AUDIO_FILE="${1:-test_audio.wav}"

if [ ! -f "$AUDIO_FILE" ]; then
    echo "Error: Audio file not found: $AUDIO_FILE"
    echo "Usage: $0 <path_to_test_audio.wav>"
    exit 1
fi

echo "========================================="
echo "Testing Whisper Endpoints"
echo "========================================="
echo "Audio: $AUDIO_FILE"
echo ""

test_endpoint() {
    local name="$1"
    local url="$2"
    
    echo "-------------------------------------------"
    echo "Testing: $name"
    echo "URL: $url"
    echo "-------------------------------------------"
    
    local start=$(date +%s%3N)
    local response=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
        "$url" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: audio/wav" \
        --data-binary "@$AUDIO_FILE" \
        --max-time 30 2>&1)
    local end=$(date +%s%3N)
    local latency=$((end - start))
    
    local http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
    local body=$(echo "$response" | grep -v "HTTP_CODE")
    
    echo "Status: $http_code"
    echo "Latency: ${latency}ms"
    
    if [ "$http_code" = "200" ]; then
        echo "SUCCESS"
        echo "Response: $(echo "$body" | jq -r '.text' 2>/dev/null | head -c 80)..."
    elif [ "$http_code" = "503" ]; then
        echo "WAKING UP (retry in 30s)"
        local retry_after=$(echo "$body" | jq -r '.estimated_time' 2>/dev/null || echo "30")
        echo "Retry after: ${retry_after}s"
    elif [ "$http_code" = "400" ]; then
        echo "ERROR"
        echo "Response: $(echo "$body" | head -c 200)"
    else
        echo "FAILED"
        echo "Response: $(echo "$body" | head -c 200)"
    fi
    
    echo ""
}

# Test all three endpoints
test_endpoint "Original (large-v3, 6GB)" \
    "https://paiabspio5ph0zvp.us-east-1.aws.endpoints.huggingface.cloud"

test_endpoint "int8 Quantized (1.5GB)" \
    "https://sgsv8hmzgyh6shoq.us-east-1.aws.endpoints.huggingface.cloud"

test_endpoint "int4 Quantized (867MB)" \
    "https://vdwzxcg14e88l16t.us-east-1.aws.endpoints.huggingface.cloud"

echo "========================================="
echo "Testing Complete"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. If int8/int4 show 503, wait and re-run this script"
echo "2. Compare latencies and transcription quality"
echo "3. Update backend/.env with fastest endpoint"
echo "4. Restart backend: pkill -f 'node server.js' && node server.js &"
echo ""
