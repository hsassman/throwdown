import { Suspense, lazy } from "react";
import App from "./App.tsx";

// ?stage opens the projector page (QR code + live leaderboard) instead of the
// game. Lazy, so the game's bundle doesn't grow and the stage page never loads
// the camera or pose model.
const StagePage = lazy(() => import("./stage/StagePage").then((m) => ({ default: m.StagePage })));

export function Root() {
  const isStage = new URLSearchParams(window.location.search).has("stage");
  if (!isStage) return <App />;
  return (
    <Suspense fallback={null}>
      <StagePage />
    </Suspense>
  );
}
