FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# libsndfile1: required by `soundfile`; libgomp1: required by onnxruntime;
# libvulkan1: litert-lm's shared library links against it even on the CPU backend
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    libgomp1 \
    libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY . .
RUN uv sync --frozen --no-dev

ENV PORT=8000
EXPOSE 8000

CMD ["uv", "run", "server.py"]
