import { Suspense, lazy } from "react";
import App from "./App.tsx";

// ?stage opens the projector page (QR code + live leaderboard) instead of the
// game. Lazy, so the game's bundle doesn't grow and the stage page never loads
// the camera or pose model.
const StagePage = lazy(() => import("./stage/StagePage").then((m) => ({ default: m.StagePage })));
// ?sensor is a phone acting as the laptop's second camera, opened from the QR
// code on the laptop's Phone Camera screen. No game, no 3D: camera, pose and
// the link.
const SensorPage = lazy(() => import("./sensor/SensorPage").then((m) => ({ default: m.SensorPage })));

export function Root() {
  const params = new URLSearchParams(window.location.search);
  const page = params.has("stage") ? <StagePage /> : params.has("sensor") ? <SensorPage /> : null;
  if (!page) return <App />;
  return <Suspense fallback={null}>{page}</Suspense>;
}
