import { useEffect, useRef } from "react";
import type { PoseFrame, Keypoint, AnyPoseKey } from "../pose/poseTypes";
import { DEBUG_CONFIG } from "../config/tuning";

// Debug landmark overlay. Ported from the Flap project's ui/PoseOverlay.tsx and
// extended with the head chain plus a raw-vs-smoothed comparison, so the
// one-euro filter's effect is visible rather than assumed.

interface Props {
  poseRef: React.RefObject<PoseFrame | null>;
  rawPoseRef: React.RefObject<PoseFrame | null>;
  /** Video is displayed mirrored (scaleX(-1)); mirror landmarks to match. */
  mirrored?: boolean;
  /** Draw the unsmoothed skeleton underneath, to see what smoothing removed. */
  showRaw?: boolean;
  /**
   * The video being overlaid. Supplying it lets the overlay account for
   * `object-fit: cover` cropping; without it landmarks are stretched across
   * the whole canvas, which only lines up when the stream's aspect ratio
   * happens to match the container's.
   */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}

const BONES: [AnyPoseKey, AnyPoseKey][] = [
  // Arm chain - the punch classification signal.
  ["leftShoulder", "rightShoulder"],
  ["leftShoulder", "leftElbow"],
  ["leftElbow", "leftWrist"],
  ["rightShoulder", "rightElbow"],
  ["rightElbow", "rightWrist"],
  // Torso - scale reference.
  ["leftShoulder", "leftHip"],
  ["rightShoulder", "rightHip"],
  ["leftHip", "rightHip"],
  // Head - the dodge/duck signal.
  ["leftEar", "leftEye"],
  ["leftEye", "nose"],
  ["nose", "rightEye"],
  ["rightEye", "rightEar"],
  // Legs and hands - not used by perception, but they drive the character's
  // stance and fists, so seeing whether they are tracked at all matters when
  // the boxer's lower body refuses to move.
  ["leftHip", "leftKnee"],
  ["leftKnee", "leftAnkle"],
  ["rightHip", "rightKnee"],
  ["rightKnee", "rightAnkle"],
  ["leftWrist", "leftIndex"],
  ["leftWrist", "leftPinky"],
  ["rightWrist", "rightIndex"],
  ["rightWrist", "rightPinky"],
];

const POINTS: AnyPoseKey[] = [
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftHip",
  "rightHip",
  "nose",
  "leftEye",
  "rightEye",
  "leftEar",
  "rightEar",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
  "leftIndex",
  "rightIndex",
  "leftPinky",
  "rightPinky",
];

/** Landmarks nothing in perception reads - drawn dimmer so the overlay still
 * reads as "these are the signals the game runs on" at a glance. */
const COSMETIC_ONLY = new Set<AnyPoseKey>([
  "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
  "leftIndex", "rightIndex", "leftPinky", "rightPinky",
]);

export function PoseOverlay({
  poseRef,
  rawPoseRef,
  mirrored = true,
  showRaw = false,
  videoRef,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId = 0;
    const minConf = DEBUG_CONFIG.minDrawConfidence;

    function resize() {
      if (!canvas || !ctx) return;
      // Backing store in device pixels for crispness, but the context is then
      // scaled so all drawing below is in CSS pixels. Without that scale, line
      // widths and dot radii are device pixels - on a 3x phone the skeleton
      // renders a third of its intended size, which is exactly the hardware
      // this most needs to be readable on.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      // Resizing the backing store resets context state, so re-apply.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Resizing also clears the canvas, so the next frame must repaint even
      // if the pose hasn't changed.
      needsRedraw = true;
    }
    let needsRedraw = true;
    let drawnPoseTs = -1;
    let drawnRawTs = -1;
    resize();

    // The stage is a flex item: it also resizes when panels appear or grow,
    // not just when the window does.
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    /**
     * Where the video image actually sits inside the canvas, in CSS pixels.
     * `object-fit: cover` scales the stream to fill the box and crops the
     * overflow, centred - so normalized landmarks map into that cropped rect,
     * not the whole element.
     */
    function coverRect() {
      const cw = canvas!.clientWidth;
      const ch = canvas!.clientHeight;
      const video = videoRef?.current;
      const vw = video?.videoWidth ?? 0;
      const vh = video?.videoHeight ?? 0;
      if (!vw || !vh || !cw || !ch) {
        return { x: 0, y: 0, w: cw, h: ch };
      }
      const videoAspect = vw / vh;
      const boxAspect = cw / ch;
      if (videoAspect > boxAspect) {
        // Wider than the box: fills height, cropped left and right.
        const w = ch * videoAspect;
        return { x: (cw - w) / 2, y: 0, w, h: ch };
      }
      const h = cw / videoAspect;
      return { x: 0, y: (ch - h) / 2, w: cw, h };
    }

    let rect = coverRect();
    const px = (kp: Keypoint) => rect.x + (mirrored ? 1 - kp.x : kp.x) * rect.w;
    const py = (kp: Keypoint) => rect.y + kp.y * rect.h;

    function drawSkeleton(
      pose: PoseFrame,
      boneColor: string,
      lineWidth: number,
      drawJoints: boolean
    ) {
      if (!ctx) return;
      ctx.strokeStyle = boneColor;
      ctx.lineWidth = lineWidth;
      for (const [a, b] of BONES) {
        const ka = pose[a];
        const kb = pose[b];
        // Optional landmarks are simply absent when out of frame.
        if (!ka || !kb) continue;
        if (ka.confidence < minConf || kb.confidence < minConf) continue;
        ctx.beginPath();
        ctx.moveTo(px(ka), py(ka));
        ctx.lineTo(px(kb), py(kb));
        ctx.stroke();
      }
      if (!drawJoints) return;

      for (const p of POINTS) {
        const kp = pose[p];
        if (!kp || kp.confidence < minConf) continue;
        const isWrist = p === "leftWrist" || p === "rightWrist";
        const isNose = p === "nose";
        // Wrists and nose are the two signals this project lives on, so they
        // get emphasised: wrists drive punch classification, nose drives dodge.
        ctx.fillStyle = COSMETIC_ONLY.has(p)
          ? "rgba(160, 200, 160, 0.6)"
          : isWrist
            ? "rgba(255, 90, 90, 0.95)"
            : isNose
              ? "rgba(120, 180, 255, 0.95)"
              : "rgba(255, 255, 255, 0.9)";
        ctx.beginPath();
        ctx.arc(
          px(kp),
          py(kp),
          COSMETIC_ONLY.has(p) ? 4 : isWrist ? 9 : isNose ? 7 : 5,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    function draw() {
      if (!canvas || !ctx) return;
      rafId = requestAnimationFrame(draw);

      const pose = poseRef.current;
      const raw = rawPoseRef.current;
      const poseTs = pose?.timestamp ?? -1;
      const rawTs = raw?.timestamp ?? -1;

      // Pose arrives at ~15 FPS but this loop runs at ~60. Repainting an
      // identical skeleton three times out of four is pure main-thread work
      // taken from the inference this app is bottlenecked on.
      if (!needsRedraw && poseTs === drawnPoseTs && rawTs === drawnRawTs) return;
      needsRedraw = false;
      drawnPoseTs = poseTs;
      drawnRawTs = rawTs;

      // Recomputed here: the stream's dimensions aren't known until metadata
      // loads, and can change if the track is reconfigured.
      rect = coverRect();
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

      if (showRaw && raw) {
        drawSkeleton(raw, "rgba(255, 160, 0, 0.45)", 3, false);
      }
      if (pose) {
        drawSkeleton(pose, "rgba(0, 255, 180, 0.9)", 4, true);
      }
    }
    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
    };
  }, [poseRef, rawPoseRef, mirrored, showRaw, videoRef]);

  // Decorative: it duplicates, in visual form, information the app already
  // reports as text. Hidden from assistive tech rather than announced as an
  // unlabelled canvas.
  return <canvas ref={canvasRef} className="pose-overlay" aria-hidden="true" />;
}
