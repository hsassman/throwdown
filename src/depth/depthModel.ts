import * as ort from "onnxruntime-web/webgpu";
import { DEPTH_CONFIG as C } from "../config/tuning";

// Loads and runs the depth network. See depthMath.ts for what goes in and
// what the output means.
//
// Runs on the main thread, deliberately. ONNX Runtime's WebGPU backend is
// asynchronous end to end - the dispatch returns at once and the readback is
// awaited - so unlike MediaPipe's synchronous detectForVideo it does not hold
// the thread while the GPU works. The pose worker's IIFE build (which
// MediaPipe needs) also cannot host ORT's ES-module runtime.

export type DepthBackend = "webgpu" | "wasm";

export interface DepthModel {
  backend: DepthBackend;
  /** Which weights file was loaded. */
  variant: string;
  /** Runs one inference on a `size` x `size` model input. */
  run(input: Float32Array, size: number): Promise<Float32Array>;
  dispose(): void;
}

/**
 * Fetches a model file, from Cache Storage when it has been fetched before.
 * The URL is pinned to a commit, so a cached copy can never be stale.
 */
async function fetchCached(
  url: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(C.cacheName);
  } catch {
    // Private windows and insecure origins may refuse Cache Storage; the
    // model still loads, it is just downloaded again next time.
  }
  const hit = await cache?.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`model download failed: ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  try {
    await cache?.put(url, new Response(bytes));
  } catch {
    // Quota exceeded: carry on uncached.
  }
  return bytes;
}

async function webGpuSupport(): Promise<{ ok: boolean; f16: boolean }> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GPUAdapterLike | null> } })
    .gpu;
  if (!gpu) return { ok: false, f16: false };
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? { ok: true, f16: adapter.features.has("shader-f16") } : { ok: false, f16: false };
  } catch {
    return { ok: false, f16: false };
  }
}
interface GPUAdapterLike {
  features: { has(name: string): boolean };
}

async function createSession(bytes: Uint8Array, backend: DepthBackend) {
  return ort.InferenceSession.create(bytes, {
    executionProviders: backend === "webgpu" ? ["webgpu"] : ["wasm"],
    graphOptimizationLevel: "all",
  });
}

/** Loads the best variant this device can run. */
export async function loadDepthModel(
  onProgress?: (loaded: number, total: number) => void
): Promise<DepthModel> {
  const gpu = await webGpuSupport();
  const attempts: { backend: DepthBackend; file: string }[] = [];
  // Measurement overrides: ?depthModel=<file stem> and ?depthEp=webgpu|wasm.
  const q = new URLSearchParams(window.location.search);
  const forcedFile = q.get("depthModel");
  const forcedEp = q.get("depthEp");
  if (forcedFile || forcedEp) {
    attempts.push({
      backend: forcedEp === "wasm" || !gpu.ok ? "wasm" : "webgpu",
      file: forcedFile ? `model_${forcedFile}.onnx` : C.modelPortable,
    });
  }
  if (gpu.ok && gpu.f16) attempts.push({ backend: "webgpu", file: C.modelWebGpuF16 });
  if (gpu.ok) attempts.push({ backend: "webgpu", file: C.modelPortable });
  attempts.push({ backend: "wasm", file: C.modelPortable });

  let lastErr: unknown = null;
  for (const a of attempts) {
    try {
      const bytes = await fetchCached(`${C.modelBase}/${a.file}`, onProgress);
      const session = await createSession(bytes, a.backend);
      return wrap(session, a.backend, a.file);
    } catch (err) {
      console.warn(`[depth] ${a.backend}/${a.file} failed:`, err);
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function wrap(session: ort.InferenceSession, backend: DepthBackend, variant: string): DepthModel {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  return {
    backend,
    variant,
    async run(input, size) {
      const tensor = new ort.Tensor("float32", input, [1, 3, size, size]);
      const out = await session.run({ [inputName]: tensor });
      const result = out[outputName];
      const data = (await result.getData()) as Float32Array | Uint16Array;
      result.dispose();
      tensor.dispose();
      // Copied out: the tensor's buffer belongs to the runtime.
      return data instanceof Float32Array ? new Float32Array(data) : Float32Array.from(data);
    },
    dispose() {
      void session.release();
    },
  };
}
