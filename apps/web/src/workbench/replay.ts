import { Quaternion, Vector3 } from 'three';
import type { ReplayData } from '../contracts';
import { frdToScene } from './geometry';

interface ReplayPose {
  position: Vector3;
  quaternion: Quaternion;
}

export interface SceneFrame extends ReplayPose { time: number }

export function nedPoseToThree(n: number, e: number, d: number, qw: number, qx: number, qy: number, qz: number): ReplayPose {
  // N→−Z, E→+X, D→−Y matches the FRD model and preserves N × E = D.
  // For this proper basis rotation, B R B⁻¹ rotates the quaternion's vector part by B.
  return {
    position: new Vector3(...frdToScene([n, e, d])),
    quaternion: new Quaternion(...frdToScene([qx, qy, qz]), qw).normalize(),
  };
}

export function toSceneFrames(frames: ReplayData['frames']): SceneFrame[] {
  return frames.map(([time, n, e, d, qw, qx, qy, qz]) => ({ time, ...nedPoseToThree(n, e, d, qw, qx, qy, qz) }));
}

export function applyReplayPose(frames: readonly SceneFrame[], time: number, target: ReplayPose) {
  if (!frames.length) return;
  let low = 0, high = frames.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (frames[mid].time <= time) low = mid;
    else high = mid;
  }
  const first = frames[low], last = frames[high];
  const span = last.time - first.time;
  const fraction = span > 0 ? Math.max(0, Math.min(1, (time - first.time) / span)) : 0;
  target.position.copy(first.position).lerp(last.position, fraction);
  target.quaternion.copy(first.quaternion).slerp(last.quaternion, fraction);
}
