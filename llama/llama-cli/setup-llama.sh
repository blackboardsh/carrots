#!/bin/bash

# Fetch and set up llama.cpp for the llama-cli project

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/deps"
LLAMA_CPP_COMMIT="aa3b7a90b"

echo "Setting up llama.cpp for llama-cli..."

mkdir -p "$DEPS_DIR"

if [ -d "$DEPS_DIR/llama.cpp" ]; then
    echo "Checking llama.cpp at commit $LLAMA_CPP_COMMIT..."
    cd "$DEPS_DIR/llama.cpp"
    git fetch
    git checkout "$LLAMA_CPP_COMMIT"
else
    echo "Cloning llama.cpp..."
    cd "$DEPS_DIR"
    git clone https://github.com/ggerganov/llama.cpp.git
    cd llama.cpp
    git checkout "$LLAMA_CPP_COMMIT"
fi

echo "llama.cpp setup complete!"
