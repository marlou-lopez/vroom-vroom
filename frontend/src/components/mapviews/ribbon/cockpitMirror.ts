import { PerspectiveCamera, Quaternion, SRGBColorSpace, Vector3, WebGLRenderTarget, type Object3D, type Scene, type Texture, type WebGLRenderer } from "three";
import { MIRROR_PX } from "./cockpitLayout";

/**
 * The cockpit's rear-view mirror (#101): a second camera at the eye looking back, rendered into a small render target that the mirror's
 * glass shows. It is redrawn at most every `MIRROR_MIN_INTERVAL_MS` (every other frame at 60 fps) and never costs the main pass anything
 * but its own draw calls. Off with `?mirror=0` in the URL (the glass then shows a still picture).
 */

/** Vertical field of view of the mirror's picture (degrees); the aspect is the glass's, so it is wide (about 74 deg) and shallow. */
export const MIRROR_FOV_DEG = 14;
/** Fastest the picture is redrawn (ms). */
export const MIRROR_MIN_INTERVAL_MS = 28;
export const MIRROR_NEAR_M = 0.3;
export const MIRROR_FAR_M = 20000;

/**
 * The direction the mirror's camera looks, from the driver's view direction: a flat mirror reflects it across the vertical plane
 * across the car, so the horizontal part turns round and the up/down part stays (looking down at the road ahead shows the road behind).
 */
export function mirrorLookDirection(forward: { x: number; y: number; z: number }): [number, number, number] {
  return [-forward.x, forward.y, -forward.z];
}

export interface CockpitMirror {
  /** The picture, to put on the glass; flip it horizontally (a mirror image). */
  texture: Texture;
  /**
   * Renders the view behind the eye of `camera` unless it did so less than `MIRROR_MIN_INTERVAL_MS` ago (`force` always renders).
   * `hide` (the camera-attached cockpit) is hidden meanwhile. `before` and `after` bracket the pass (for line widths in px).
   * Returns whether it rendered.
   */
  render(gl: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, hide: Object3D, nowMs: number, force: boolean, before?: () => void, after?: () => void): boolean;
  dispose(): void;
}

export function createCockpitMirror(): CockpitMirror {
  const [w, h] = MIRROR_PX;
  const target = new WebGLRenderTarget(w, h, { samples: 4, depthBuffer: true });
  target.texture.colorSpace = SRGBColorSpace;
  const cam = new PerspectiveCamera(MIRROR_FOV_DEG, w / h, MIRROR_NEAR_M, MIRROR_FAR_M);
  const fwd = new Vector3(), up = new Vector3(), q = new Quaternion();
  let last = -Infinity;
  return {
    texture: target.texture,
    render(gl, scene, camera, hide, nowMs, force, before, after) {
      if (!force && nowMs - last < MIRROR_MIN_INTERVAL_MS) return false;
      last = nowMs;
      q.copy(camera.quaternion);
      fwd.set(0, 0, -1).applyQuaternion(q);
      up.set(0, 1, 0).applyQuaternion(q); // the car's up (rolled with it), kept so a leaning car tilts the picture as the windscreen's
      const [dx, dy, dz] = mirrorLookDirection(fwd);
      cam.position.copy(camera.position);
      cam.up.copy(up);
      cam.lookAt(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz);
      cam.updateMatrixWorld();
      const prev = gl.getRenderTarget();
      const was = hide.visible;
      hide.visible = false;
      before?.();
      gl.setRenderTarget(target);
      gl.render(scene, cam);
      gl.setRenderTarget(prev);
      after?.();
      hide.visible = was;
      return true;
    },
    dispose() {
      target.dispose();
    },
  };
}
