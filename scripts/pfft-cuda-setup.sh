#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT}/native/cuda/pfft_cuda_miner.cu"
OUT_DIR="${ROOT}/runtime/bin"
OUT="${OUT_DIR}/pfft-cuda-miner"

mkdir -p "$OUT_DIR"

NVCC="${NVCC:-}"
if [ -z "$NVCC" ]; then
  if command -v nvcc >/dev/null 2>&1; then
    NVCC="$(command -v nvcc)"
  elif [ -x /usr/local/cuda/bin/nvcc ]; then
    NVCC="/usr/local/cuda/bin/nvcc"
  else
    match="$(ls /usr/local/cuda-*/bin/nvcc 2>/dev/null | sort -V | tail -n 1 || true)"
    if [ -n "$match" ]; then NVCC="$match"; fi
  fi
fi

if [ -z "$NVCC" ] || [ ! -x "$NVCC" ]; then
  echo "nvcc not found. Install NVIDIA CUDA Toolkit on the GPU server."
  exit 1
fi

echo "Compiling CUDA miner with $NVCC..."
HOST_COMPILER="${CUDAHOSTCXX:-}"
if [ -z "$HOST_COMPILER" ]; then
  for candidate in /usr/bin/g++-13 /usr/bin/g++-12 /usr/bin/g++; do
    if [ -x "$candidate" ]; then
      HOST_COMPILER="$candidate"
      break
    fi
  done
fi

HOST_ARGS=()
if [ -n "$HOST_COMPILER" ]; then
  HOST_ARGS=(-ccbin "$HOST_COMPILER")
  echo "Using host compiler $HOST_COMPILER"
fi

"$NVCC" -O3 -std=c++17 -allow-unsupported-compiler \
  "${HOST_ARGS[@]}" \
  -Xcompiler -Wall \
  -o "$OUT" "$SRC"

chmod +x "$OUT"
echo "CUDA miner built: $OUT"
