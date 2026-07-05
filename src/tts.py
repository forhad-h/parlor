"""Platform-aware Kokoro TTS: mlx-audio on Apple Silicon, kokoro-onnx elsewhere."""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np


def _is_apple_silicon() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


class TTSBackend:
    """Unified TTS interface."""

    sample_rate: int = 24000

    def generate(self, text: str, voice: str = "af_heart", speed: float = 1.1) -> np.ndarray:
        raise NotImplementedError


def _brew_espeak_prefix() -> Path | None:
    """Resolve the espeak-ng Homebrew prefix, wherever brew put it."""
    brew = shutil.which("brew")
    if not brew:
        return None
    try:
        result = subprocess.run(
            [brew, "--prefix", "espeak-ng"], capture_output=True, text=True, timeout=5
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return Path(result.stdout.strip())


def _fix_espeak_data_path() -> None:
    """Point phonemizer at a Homebrew-built espeak-ng.

    The espeakng-loader wheel bundles a libespeak-ng.dylib that ignores the
    data path passed to espeak_Initialize and always looks for
    /Users/runner/work/espeakng-loader/... (its CI build path), so misaki's
    phonemization fails with "No such file or directory" for phontab.
    Requires `brew install espeak-ng`.
    """
    import misaki.espeak  # noqa: F401  (runs its own, broken, set_library/set_data_path)
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    candidates = []
    brew_prefix = _brew_espeak_prefix()
    if brew_prefix:
        candidates.append(brew_prefix)
    candidates += [Path("/opt/homebrew/opt/espeak-ng"), Path("/usr/local/opt/espeak-ng")]

    for prefix in candidates:
        lib = prefix / "lib" / "libespeak-ng.dylib"
        data = prefix / "share" / "espeak-ng-data"
        if lib.exists() and data.exists():
            EspeakWrapper.set_library(str(lib))
            EspeakWrapper.set_data_path(str(data))
            return

    raise RuntimeError(
        "Could not find a working espeak-ng install for text-to-speech.\n"
        "The espeak-ng bundled with the 'espeakng-loader' PyPI package is "
        "broken on macOS (it ignores its data path at runtime).\n"
        "Fix: run `brew install espeak-ng`."
    )


class MLXBackend(TTSBackend):
    """mlx-audio backend (Apple Silicon GPU via MLX)."""

    def __init__(self):
        from mlx_audio.tts.generate import load_model

        _fix_espeak_data_path()
        self._model = load_model("mlx-community/Kokoro-82M-bf16")
        self.sample_rate = self._model.sample_rate
        # Warmup: triggers pipeline init (phonemizer, spacy, etc.)
        list(self._model.generate(text="Hello", voice="af_heart", speed=1.0))

    def generate(self, text: str, voice: str = "af_heart", speed: float = 1.1) -> np.ndarray:
        results = list(self._model.generate(text=text, voice=voice, speed=speed))
        return np.concatenate([np.array(r.audio) for r in results])


class ONNXBackend(TTSBackend):
    """kokoro-onnx backend (ONNX Runtime, CPU)."""

    def __init__(self):
        import kokoro_onnx
        from huggingface_hub import hf_hub_download

        model_path = hf_hub_download("fastrtc/kokoro-onnx", "kokoro-v1.0.onnx")
        voices_path = hf_hub_download("fastrtc/kokoro-onnx", "voices-v1.0.bin")

        self._model = kokoro_onnx.Kokoro(model_path, voices_path)
        self.sample_rate = 24000

    def generate(self, text: str, voice: str = "af_heart", speed: float = 1.1) -> np.ndarray:
        pcm, _sr = self._model.create(text, voice=voice, speed=speed)
        return pcm


def load() -> TTSBackend:
    """Load the best available TTS backend for this platform."""
    if _is_apple_silicon() and not os.environ.get("KOKORO_ONNX"):
        try:
            backend = MLXBackend()
            print(f"TTS: mlx-audio (Apple GPU, sample_rate={backend.sample_rate})")
            return backend
        except ImportError:
            print("TTS: mlx-audio not installed, falling back to kokoro-onnx")

    backend = ONNXBackend()
    print(f"TTS: kokoro-onnx (CPU, sample_rate={backend.sample_rate})")
    return backend
