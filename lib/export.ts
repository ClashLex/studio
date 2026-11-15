/**
 * Export system: raster images at any resolution (PNG/JPG/WebP), animated
 * video rendered offscreen at up to 4K, project files (.zoxilsi JSON,
 * re-importable), and CSS/SVG/React/HTML code approximations.
 *
 * Raster and video exports run the exact two-pass pipeline (Hermite mesh →
 * render target → effects) on a throwaway offscreen context, so the output
 * matches the artboard pixel-for-pixel at any resolution.
 */

import * as THREE from "three";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { ExportImageOptions, MeshDoc } from "@/types/gradient";
import { fillNodeBuffersAt, MAX_NODES } from "./engine";
import { createSurfaceBuffers, evalSurface, subdivisionFor } from "./mesh";
import { hexToRgb } from "./color";
import { meshVertexShader, meshFragmentShader, COLOR_SPACE_INDEX } from "@/shaders/meshPass";
import {
  postVertexShader,
  postFragmentShader,
  createPostUniforms,
  applyEffectsUniforms,
} from "@/shaders/postPass";

/* -------------------------------- raster --------------------------------- */

const MIME: Record<ExportImageOptions["format"], string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

export function constrainExportDimensions(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(maxEdge) ||
    width < 1 ||
    height < 1 ||
    maxEdge < 1
  ) {
    throw new Error("Export dimensions must be positive finite numbers.");
  }

  const scale = Math.min(1, maxEdge / width, maxEdge / height);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export async function renderImageBlob(
  doc: MeshDoc,
  time: number,
  opts: ExportImageOptions,
  flowTime = 0
): Promise<Blob> {
  const dimensions = constrainExportDimensions(opts.width, opts.height, 8192);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  if (
    dimensions.width > renderer.capabilities.maxTextureSize ||
    dimensions.height > renderer.capabilities.maxTextureSize
  ) {
    renderer.dispose();
    throw new Error(
      `This device supports exports up to ${renderer.capabilities.maxTextureSize}px per edge.`
    );
  }
  renderer.setSize(dimensions.width, dimensions.height, false);

  // Pass 1: mesh at export-grade subdivision
  const sub = Math.min(32, subdivisionFor(doc.rows, doc.cols) * 2);
  const buf = createSurfaceBuffers(doc.rows, doc.cols, sub);
  const nodePos = new Float32Array(MAX_NODES * 2);
  const nodeCol = new Float32Array(MAX_NODES * 3);
  fillNodeBuffersAt(doc, time, nodePos, nodeCol, flowTime);
  evalSurface(buf, doc.rows, doc.cols, sub, nodePos, nodeCol, doc.nodes);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(buf.positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(buf.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(buf.indices, 1));
  const meshMaterial = new THREE.ShaderMaterial({
    vertexShader: meshVertexShader,
    fragmentShader: meshFragmentShader,
    uniforms: { uColorSpace: { value: COLOR_SPACE_INDEX[doc.canvas.colorSpace] ?? 2 } },
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, meshMaterial);
  mesh.frustumCulled = false;
  const meshScene = new THREE.Scene();
  meshScene.add(mesh);

  const target = new THREE.WebGLRenderTarget(dimensions.width, dimensions.height, {
    depthBuffer: false,
    stencilBuffer: false,
  });

  // Pass 2: effects
  const postUniforms = createPostUniforms();
  applyEffectsUniforms(postUniforms, doc.effects);
  postUniforms.uResolution.value = [dimensions.width, dimensions.height];
  postUniforms.uTime.value = time;
  postUniforms.tDiffuse.value = target.texture;
  const postMaterial = new THREE.ShaderMaterial({
    vertexShader: postVertexShader,
    fragmentShader: postFragmentShader,
    uniforms: postUniforms,
    depthTest: false,
    depthWrite: false,
  });
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(quadGeometry, postMaterial);
  quad.frustumCulled = false;
  const postScene = new THREE.Scene();
  postScene.add(quad);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  try {
    const bg = hexToRgb(doc.canvas.backgroundColor);
    const clear = new THREE.Color();
    clear.setRGB(bg.r, bg.g, bg.b, THREE.LinearSRGBColorSpace);
    renderer.setClearColor(clear, 1);
    renderer.setRenderTarget(target);
    renderer.render(meshScene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, camera);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, MIME[opts.format], 0.95)
    );
    if (!blob) throw new Error("Canvas export failed — the browser returned no data.");
    return blob;
  } finally {
    geometry.dispose();
    quadGeometry.dispose();
    meshMaterial.dispose();
    postMaterial.dispose();
    target.dispose();
    renderer.dispose();
  }
}

/* --------------------------------- video --------------------------------- */

export interface VideoRecording {
  stop: () => void;
  done: Promise<Blob>;
  mimeType: string;
}

export interface VideoExportOptions {
  width: number;
  height: number;
  fps: number;
  seconds: number;
}

function pickRecorderMime(): string {
  const candidates =
    Capacitor.getPlatform() === "android"
      ? ["video/webm;codecs=vp8", "video/mp4", "video/webm", "video/webm;codecs=vp9"]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  const mime =
    candidates.find(
      (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)
    ) ?? "";
  if (!mime) throw new Error("This browser does not support video recording.");
  return mime;
}

/**
 * Record the animated gradient at full export resolution (up to 4K+).
 *
 * Instead of capturing the on-screen artboard (limited to its CSS pixel
 * size), this drives the exact two-pass pipeline on an offscreen canvas at
 * `opts.width × opts.height`, advancing the same clocks the live engine
 * uses — node drift, hue flow and grain all animate — and encodes the
 * stream at a bitrate scaled to the pixel rate, so 4K output stays crisp.
 */
export function renderVideoBlob(
  doc: MeshDoc,
  opts: VideoExportOptions,
  start: { time: number; flowTime: number }
): VideoRecording {
  const mimeType = pickRecorderMime();
  const dimensions = constrainExportDimensions(opts.width, opts.height, 8192);
  const fps = opts.fps;
  const seconds = opts.seconds;

  // Recording always animates, whatever the editor's play state.
  const animDoc: MeshDoc = {
    ...doc,
    animation: { ...doc.animation, playing: true },
  };

  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  if (typeof canvas.captureStream !== "function") {
    throw new Error("This browser cannot capture video from a canvas.");
  }
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: false,
    antialias: true,
    powerPreference: "high-performance",
  });
  if (
    dimensions.width > renderer.capabilities.maxTextureSize ||
    dimensions.height > renderer.capabilities.maxTextureSize
  ) {
    renderer.dispose();
    throw new Error(
      `This device supports video exports up to ${renderer.capabilities.maxTextureSize}px per edge.`
    );
  }
  renderer.setSize(dimensions.width, dimensions.height, false);

  const sub = Math.min(32, subdivisionFor(doc.rows, doc.cols) * 2);
  const buf = createSurfaceBuffers(doc.rows, doc.cols, sub);
  const nodePos = new Float32Array(MAX_NODES * 2);
  const nodeCol = new Float32Array(MAX_NODES * 3);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(buf.positions, 3);
  const colAttr = new THREE.BufferAttribute(buf.colors, 3);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("color", colAttr);
  geometry.setIndex(new THREE.BufferAttribute(buf.indices, 1));
  const meshMaterial = new THREE.ShaderMaterial({
    vertexShader: meshVertexShader,
    fragmentShader: meshFragmentShader,
    uniforms: { uColorSpace: { value: COLOR_SPACE_INDEX[doc.canvas.colorSpace] ?? 2 } },
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, meshMaterial);
  mesh.frustumCulled = false;
  const meshScene = new THREE.Scene();
  meshScene.add(mesh);

  const target = new THREE.WebGLRenderTarget(dimensions.width, dimensions.height, {
    depthBuffer: false,
    stencilBuffer: false,
  });

  const postUniforms = createPostUniforms();
  applyEffectsUniforms(postUniforms, doc.effects);
  postUniforms.uResolution.value = [dimensions.width, dimensions.height];
  postUniforms.tDiffuse.value = target.texture;
  const postMaterial = new THREE.ShaderMaterial({
    vertexShader: postVertexShader,
    fragmentShader: postFragmentShader,
    uniforms: postUniforms,
    depthTest: false,
    depthWrite: false,
  });
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(quadGeometry, postMaterial);
  quad.frustumCulled = false;
  const postScene = new THREE.Scene();
  postScene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const bg = hexToRgb(doc.canvas.backgroundColor);
  const clear = new THREE.Color();
  clear.setRGB(bg.r, bg.g, bg.b, THREE.LinearSRGBColorSpace);
  renderer.setClearColor(clear, 1);

  // Keep the mobile encode bitrate modest while scaling desktop output to size.
  const bitrate = Math.min(
    80_000_000,
    Math.max(8_000_000, Math.round(dimensions.width * dimensions.height * fps * 0.12))
  );
  const stream = canvas.captureStream(fps);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    geometry.dispose();
    quadGeometry.dispose();
    meshMaterial.dispose();
    postMaterial.dispose();
    target.dispose();
    renderer.dispose();
    throw error;
  }
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  let raf = 0;
  let timer = 0;
  let disposed = false;
  let last = performance.now();
  let lastRender = last - 1000 / fps;
  const frameInterval = 1000 / fps;
  let time = start.time;
  let flow = start.flowTime;
  let shader = 0;
  const dir = doc.animation.reversed ? -1 : 1;

  const renderFrame = (now: number) => {
    raf = requestAnimationFrame(renderFrame);
    if (now - lastRender < frameInterval) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    lastRender = now;
    time += dt * doc.animation.speed * dir;
    flow += dt * doc.animation.speed * dir * (doc.animation.hueFlow ?? 0);
    shader += dt;

    fillNodeBuffersAt(animDoc, time, nodePos, nodeCol, flow);
    evalSurface(buf, doc.rows, doc.cols, sub, nodePos, nodeCol, doc.nodes);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    postUniforms.uTime.value = shader;

    renderer.setRenderTarget(target);
    renderer.render(meshScene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, camera);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    if (timer) window.clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    geometry.dispose();
    quadGeometry.dispose();
    meshMaterial.dispose();
    postMaterial.dispose();
    target.dispose();
    renderer.dispose();
  };

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      dispose();
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size === 0) reject(new Error("Video export produced no frames."));
      else resolve(blob);
    };
    recorder.onerror = () => {
      dispose();
      reject(new Error("Video recording failed."));
    };
  });

  try {
    recorder.start(1000);
  } catch (error) {
    dispose();
    throw new Error(
      error instanceof Error ? `Video recording could not start: ${error.message}` : "Video recording could not start."
    );
  }
  raf = requestAnimationFrame(renderFrame);
  timer = window.setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, seconds * 1000);

  return {
    mimeType,
    done,
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}

/* ------------------------------- code export ------------------------------ */

/** Radial-gradient approximation of the mesh — for CSS-based formats. */
export function docToCssBackground(doc: MeshDoc): {
  backgroundColor: string;
  backgroundImage: string;
} {
  const reach = Math.min(95, Math.round(130 / Math.max(doc.rows - 1, doc.cols - 1)));
  const layers = doc.nodes.map((n) => {
    const x = (n.position.x * 100).toFixed(1);
    const y = ((1 - n.position.y) * 100).toFixed(1);
    return `radial-gradient(at ${x}% ${y}%, ${n.color} 0%, transparent ${reach}%)`;
  });
  return {
    backgroundColor: doc.canvas.backgroundColor,
    backgroundImage: layers.join(", "),
  };
}

export function exportCss(doc: MeshDoc): string {
  const { backgroundColor, backgroundImage } = docToCssBackground(doc);
  const layers = backgroundImage.split("), radial").join("),\n    radial");
  return [
    "/* zoxilsi studio gradient — CSS approximation of the WebGL mesh */",
    ".mesh-gradient {",
    `  background-color: ${backgroundColor};`,
    `  background-image:\n    ${layers};`,
    "}",
  ].join("\n");
}

export function exportTailwind(doc: MeshDoc): string {
  const { backgroundColor, backgroundImage } = docToCssBackground(doc);
  const value = backgroundImage.replace(/\s+/g, "_");
  return [
    "<!-- zoxilsi studio gradient — Tailwind arbitrary values -->",
    `<div class="h-96 w-full rounded-3xl bg-[${backgroundColor}] [background-image:${value}]"></div>`,
  ].join("\n");
}

export function exportSvg(doc: MeshDoc, width = 1600, height = 1200): string {
  const reach = Math.min(140, Math.round(170 / Math.max(doc.rows - 1, doc.cols - 1)));
  const defs = doc.nodes
    .map((n, i) =>
      [
        `    <radialGradient id="g${i}" cx="${(n.position.x * 100).toFixed(1)}%" cy="${((1 - n.position.y) * 100).toFixed(1)}%" r="${reach}%">`,
        `      <stop offset="0%" stop-color="${n.color}"/>`,
        `      <stop offset="100%" stop-color="${n.color}" stop-opacity="0"/>`,
        `    </radialGradient>`,
      ].join("\n")
    )
    .join("\n");
  const rects = doc.nodes
    .map((_, i) => `    <rect width="100%" height="100%" fill="url(#g${i})"/>`)
    .join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <defs>`,
    defs,
    `    <filter id="soften"><feGaussianBlur stdDeviation="${Math.round(width * 0.015)}"/></filter>`,
    `  </defs>`,
    `  <rect width="100%" height="100%" fill="${doc.canvas.backgroundColor}"/>`,
    `  <g filter="url(#soften)">`,
    rects,
    `  </g>`,
    `</svg>`,
  ].join("\n");
}

export function exportReact(doc: MeshDoc): string {
  const { backgroundColor, backgroundImage } = docToCssBackground(doc);
  return [
    "// zoxilsi studio gradient — drop-in React component (static CSS approximation).",
    "// For the exact animated WebGL mesh, export the project JSON and",
    "// reload it in zoxilsi studio.",
    "export function MeshGradient({ className }: { className?: string }) {",
    "  return (",
    "    <div",
    "      aria-hidden",
    "      className={className}",
    "      style={{",
    `        backgroundColor: "${backgroundColor}",`,
    `        backgroundImage: \`${backgroundImage}\`,`,
    "      }}",
    "    />",
    "  );",
    "}",
  ].join("\n");
}

export function exportHtml(doc: MeshDoc): string {
  const { backgroundColor, backgroundImage } = docToCssBackground(doc);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8"/>',
    '  <meta name="viewport" content="width=device-width, initial-scale=1"/>',
    "  <title>zoxilsi studio gradient</title>",
    "  <style>",
    "    html, body { margin: 0; height: 100%; }",
    "    .mesh-gradient {",
    "      height: 100%;",
    `      background-color: ${backgroundColor};`,
    `      background-image: ${backgroundImage};`,
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    '  <div class="mesh-gradient"></div>',
    "</body>",
    "</html>",
  ].join("\n");
}

/* ------------------------------ project files ----------------------------- */

export function exportJson(doc: MeshDoc): string {
  return JSON.stringify({ app: "zoxilsi-studio", version: 2, doc }, null, 2);
}

export function parseImportedJson(text: string): MeshDoc {
  const data = JSON.parse(text);
  const doc = data?.doc ?? data;
  if (
    !Number.isInteger(doc?.rows) ||
    !Number.isInteger(doc?.cols) ||
    !Array.isArray(doc?.nodes) ||
    doc.nodes.length !== doc.rows * doc.cols ||
    !doc?.canvas ||
    !doc?.effects ||
    !doc?.animation
  ) {
    throw new Error("Not a valid zoxilsi studio project file.");
  }
  const parsed = doc as MeshDoc;
  // Files saved before hue flow existed stay exactly as they looked.
  if (typeof parsed.animation.hueFlow !== "number") parsed.animation.hueFlow = 0;
  return parsed;
}

/* -------------------------------- download -------------------------------- */

const NATIVE_WRITE_CHUNK_SIZE = 1024 * 1024;
const MAX_NATIVE_SHARE_SIZE = 25 * 1024 * 1024;

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the export."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not encode the export file."));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error("Could not encode the export file."));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  if (Capacitor.getPlatform() === "android") {
    const safeName = filename.replace(/[\\/]/g, "-");
    const path = `zoxilsi studio/exports/${Date.now()}-${safeName}`;
    const firstChunk = blob.slice(0, NATIVE_WRITE_CHUNK_SIZE);
    await Filesystem.writeFile({
      path,
      data: await blobToBase64(firstChunk),
      directory: Directory.Documents,
      recursive: true,
    });
    for (let offset = firstChunk.size; offset < blob.size; offset += NATIVE_WRITE_CHUNK_SIZE) {
      await Filesystem.appendFile({
        path,
        data: await blobToBase64(blob.slice(offset, offset + NATIVE_WRITE_CHUNK_SIZE)),
        directory: Directory.Documents,
      });
    }
    return;
  }

  if (Capacitor.isNativePlatform()) {
    if (blob.size > MAX_NATIVE_SHARE_SIZE) {
      throw new Error("This export is too large to share from the app. Choose a smaller size or duration.");
    }

    const safeName = filename.replace(/[\\/]/g, "-");
    const data = await blobToBase64(blob);
    const { uri } = await Filesystem.writeFile({
      path: `exports/${Date.now()}-${safeName}`,
      data,
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({
      title: filename,
      dialogTitle: "Save or share export",
      files: [uri],
    });
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function downloadText(
  text: string,
  filename: string,
  type = "text/plain"
): Promise<void> {
  await downloadBlob(new Blob([text], { type }), filename);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
