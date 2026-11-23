/** Which models Dudeling runs and where they live (no imports of the engines themselves). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const STT_MODEL = "onnx-community/whisper-base.en";
export const VOICE = "af_heart";
export const MODELS_DIR = process.env.DUDELING_MODELS_DIR ?? fileURLToPath(new URL("../models", import.meta.url));

/** The extension ships the engine for Apple-silicon Macs and 64-bit Intel/AMD Windows only, and a manifest can't say which chip. */
export const unsupportedHere = () =>
  (process.platform === "darwin" && process.arch !== "arm64") || (process.platform === "win32" && process.arch !== "x64");
export const unsupportedMessage = () =>
  process.platform === "win32"
    ? "Dudeling on Windows needs a 64-bit Intel or AMD processor. This PC has an ARM processor."
    : "Dudeling needs a Mac with Apple silicon (M1 or later). This Mac has an Intel chip.";

/** Models are fetched when missing, except in the extension (which ships them). */
export const downloadsAllowed = () => process.env.DUDELING_VOICE_DOWNLOAD !== "off";
export const voiceInstalled = () => existsSync(join(MODELS_DIR, TTS_MODEL, "onnx/model_quantized.onnx"));
export const hearingInstalled = () => existsSync(join(MODELS_DIR, STT_MODEL, "onnx/encoder_model_quantized.onnx"));
