#!/bin/bash

# Configuration
MODEL_DIR="data/models"
BASE_URL="https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights"

# Create models directory if not exists
mkdir -p "$MODEL_DIR"

# List of models to download
MODELS=(
    "ssd_mobilenetv1_model-weights_manifest.json"
    "ssd_mobilenetv1_model-shard1"
    "ssd_mobilenetv1_model-shard2"
    "face_landmark_68_model-weights_manifest.json"
    "face_landmark_68_model-shard1"
    "face_recognition_model-weights_manifest.json"
    "face_recognition_model-shard1"
    "face_recognition_model-shard2"
)

echo "Downloading face-api models to $MODEL_DIR..."

for model in "${MODELS[@]}"; do
    echo "Downloading $model..."
    curl -L "$BASE_URL/$model" -o "$MODEL_DIR/$model"
done

echo "Done."
