import { memo, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DroneIR, ReplayData } from '../contracts';
import type { CameraPreset, ModelCameraPose } from './state';
import { frdToScene, inspectIR } from './geometry';
import { applyReplayPose, toSceneFrames, type SceneFrame } from './replay';

interface Props {
  ir: DroneIR; modelKey: string; explode: number; spinning: boolean;
  activePart: string | null; camera: CameraPreset; reset: number;
  onPart?: (part: string) => void;
  modelCamera?: MutableRefObject<ModelCameraPose | null>;
  replay?: ReplayData;
  replayTime?: RefObject<number>;
}
interface Moving { object: THREE.Object3D; base: THREE.Vector3; offset: THREE.Vector3 }
interface Engine {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  model: THREE.Group; grid: THREE.GridHelper; moving: Moving[]; props: { object: THREE.Object3D; sign: number }[];
  radius: number; visible: boolean;
  replay: { frames: SceneFrame[]; line: THREE.Line; center: THREE.Vector3; radius: number } | null;
}

function dispose(group: THREE.Object3D) {
  group.traverse(object => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      (material as THREE.MeshStandardMaterial).map?.dispose(); material.dispose();
    }
  });
}

function label(text: string, color: string, position: THREE.Vector3) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 28px sans-serif'; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(text, 128, 42);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.position.copy(position); sprite.scale.set(0.25, 0.0625, 1); return sprite;
}

function fit(engine: Engine, { camera: preset, reset, modelCamera }: Props) {
  const radius = Math.max(engine.replay?.radius ?? engine.radius, 0.45);
  engine.controls.maxDistance = engine.replay ? Math.max(15, radius * 15) : 15;
  engine.camera.far = Math.max(100, engine.controls.maxDistance * 2);
  engine.camera.updateProjectionMatrix();
  const saved = modelCamera?.current;
  if (!engine.replay && saved?.preset === preset && saved.reset === reset) {
    engine.camera.position.fromArray(saved.position);
    engine.controls.target.fromArray(saved.target);
    engine.controls.update();
    return;
  }
  const direction = preset === 'top' ? new THREE.Vector3(0, 3, 0.001) : preset === 'side' ? new THREE.Vector3(3, 0.3, 0.02) : new THREE.Vector3(1.65, 1.25, 1.65);
  const target = engine.replay?.center ?? new THREE.Vector3(0, 0.04, 0);
  const aspectScale = Math.max(1, 1 / engine.camera.aspect);
  engine.camera.position.copy(direction.multiplyScalar(radius * aspectScale)).add(target);
  engine.controls.target.copy(target); engine.camera.lookAt(target); engine.controls.update();
}

function Drone3DViewer(props: Props) {
  const host = useRef<HTMLDivElement>(null), engine = useRef<Engine | null>(null);
  const current = useRef(props); current.current = props;
  const [unavailable, setUnavailable] = useState(false);
  const irKey = JSON.stringify(props.ir);
  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
    catch { setUnavailable(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#f0f3fa'); element.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', '无人机三维构型');
    renderer.domElement.setAttribute('role', 'img');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.005, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.09; controls.minDistance = 0.15; controls.maxDistance = 15;
    scene.add(new THREE.HemisphereLight('#ffffff', '#8c98b4', 2.8));
    const light = new THREE.DirectionalLight('#ffffff', 3.4); light.position.set(2, 4, 1); scene.add(light);
    const fill = new THREE.DirectionalLight('#b1b0ff', 1.4); fill.position.set(-2, 0.7, -2); scene.add(fill);
    const grid = new THREE.GridHelper(4, 40, '#ccd3e4', '#e1e5ef'); grid.position.y = -0.22; scene.add(grid);
    const model = new THREE.Group(); scene.add(model);
    const e: Engine = { renderer, scene, camera, controls, model, grid, moving: [], props: [], radius: 0.6, visible: true, replay: null }; engine.current = e;
    const resize = new ResizeObserver(() => {
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight);
      renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
    }); resize.observe(element);
    renderer.setSize(element.clientWidth || 480, element.clientHeight || 320);
    camera.aspect = (element.clientWidth || 480) / (element.clientHeight || 320); camera.updateProjectionMatrix();
    const visible = new IntersectionObserver(([entry]) => { e.visible = entry.isIntersecting; }); visible.observe(element);
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let down = [0, 0];
    const onDown = (event: PointerEvent) => { down = [event.clientX, event.clientY]; };
    const onUp = (event: PointerEvent) => {
      if (!current.current.onPart) return;
      if (Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(model, true).find(item => item.object.userData.partId);
      if (hit) current.current.onPart(hit.object.userData.partId);
    };
    renderer.domElement.addEventListener('pointerdown', onDown); renderer.domElement.addEventListener('pointerup', onUp);
    const lost = (event: Event) => { event.preventDefault(); setUnavailable(true); };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    let frame = 0, previous = performance.now(), factor = current.current.explode;
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      const delta = Math.min(0.05, (now - previous) / 1000); previous = now;
      if (!e.visible || document.hidden) return;
      if (e.replay) applyReplayPose(e.replay.frames, current.current.replayTime?.current ?? e.replay.frames[0].time, model);
      factor += (current.current.explode - factor) * Math.min(1, delta * 12);
      for (const part of e.moving) part.object.position.copy(part.base).addScaledVector(part.offset, factor);
      if (current.current.spinning) for (const prop of e.props) prop.object.rotation.y += delta * 18 * prop.sign;
      model.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
        const active = object.userData.partId === current.current.activePart;
        object.material.emissive.set(active ? '#5d45cf' : '#000000'); object.material.emissiveIntensity = active ? 0.4 : 0;
      });
      controls.update(); renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(render);
    return () => {
      const { modelCamera, camera: preset, reset } = current.current;
      if (modelCamera && !e.replay) modelCamera.current = { position: camera.position.toArray(), target: controls.target.toArray(), preset, reset };
      cancelAnimationFrame(frame); resize.disconnect(); visible.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown); renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      dispose(scene); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); engine.current = null;
    };
  }, []);

  useEffect(() => {
    const e = engine.current; if (!e) return;
    dispose(e.model); e.model.clear(); e.moving = []; e.props = [];
    const ir = props.ir, validation = inspectIR(ir);
    const material = (color: string, transparent = false, opacity = 1) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.23, transparent, opacity, side: THREE.DoubleSide });
    const mesh = (geometry: THREE.BufferGeometry, color: string, id: string, group: THREE.Object3D, position = new THREE.Vector3(), transparent = false, opacity = 1) => {
      const object = new THREE.Mesh(geometry, material(color, transparent, opacity)); object.position.copy(position); object.userData.partId = id; group.add(object); return object;
    };
    const moving = (object: THREE.Object3D, offset: THREE.Vector3) => e.moving.push({ object, base: object.position.clone(), offset });
    const body = new THREE.Group(); e.model.add(body);
    mesh(new THREE.BoxGeometry(0.15, 0.016, 0.19), '#263651', 'airframe', body);
    const upper = new THREE.Group(); upper.position.y = 0.035; e.model.add(upper); moving(upper, new THREE.Vector3(0, 0.13, 0));
    mesh(new THREE.BoxGeometry(0.13, 0.01, 0.17), '#354661', 'airframe', upper);
    mesh(new THREE.BoxGeometry(0.065, 0.025, 0.075), '#6872a6', 'controller', upper, new THREE.Vector3(0, 0.018, 0));
    const battery = new THREE.Group(); battery.position.y = 0.08; e.model.add(battery); moving(battery, new THREE.Vector3(0, 0.23, 0));
    const scale = Math.cbrt(Math.max(1, ir.power.capacity_wh) / 72);
    mesh(new THREE.BoxGeometry(0.065 * scale, 0.035 * scale, 0.12 * scale), '#6552be', 'power', battery);
    mesh(new THREE.BoxGeometry(0.07 * scale, 0.004, 0.016), '#b3a6ed', 'power', battery, new THREE.Vector3(0, 0.02 * scale, 0.025));
    const payload = new THREE.Group(); payload.position.fromArray(frdToScene(ir.payload.position_m)).add(new THREE.Vector3(0, -0.09, 0)); e.model.add(payload); moving(payload, new THREE.Vector3(0, -0.2, 0));
    const payloadScale = Math.cbrt(Math.max(0.02, ir.payload.mass_kg) / 0.2);
    mesh(new THREE.BoxGeometry(0.06 * payloadScale, 0.045 * payloadScale, 0.065 * payloadScale), '#a2acbf', 'payload', payload);
    const lens = mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.014, 20), '#293c56', 'payload', payload, new THREE.Vector3(0, 0, -0.04)); lens.rotation.x = Math.PI / 2;
    mesh(new THREE.SphereGeometry(0.012, 16, 12), '#f1ac46', 'airframe', e.model, new THREE.Vector3().fromArray(frdToScene(validation.cg)), true, 0.8);
    for (const rotor of ir.rotors) {
      const id = `rotor:${rotor.id}`, position = new THREE.Vector3().fromArray(frdToScene(rotor.position_m));
      const group = new THREE.Group(); e.model.add(group);
      const offset = position.clone().normalize().multiplyScalar(0.18); moving(group, offset);
      const length = position.length();
      const arm = mesh(new THREE.CylinderGeometry(0.009, 0.009, Math.max(0.001, length), 12), '#45546c', id, group, position.clone().multiplyScalar(0.5));
      if (length) arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), position.clone().normalize());
      const motor = new THREE.Group(); motor.position.copy(position); group.add(motor);
      const axis = new THREE.Vector3().fromArray(frdToScene(rotor.thrust_axis)); if (axis.length() < 1e-6) axis.set(0, 1, 0); axis.normalize();
      motor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      mesh(new THREE.CylinderGeometry(0.023, 0.025, 0.035, 24), '#33445d', id, motor);
      const prop = new THREE.Group(); prop.position.y = 0.029; motor.add(prop); moving(prop, new THREE.Vector3(0, 0.1, 0)); e.props.push({ object: prop, sign: rotor.spin_direction });
      const radius = Math.max(0.003, rotor.prop_radius_m);
      const color = validation.conflicts.has(rotor.id) ? '#ed6d72' : rotor.spin_direction === 1 ? '#6e63d8' : '#3daba6';
      mesh(new THREE.CylinderGeometry(radius, radius, 0.002, 48), color, id, prop, new THREE.Vector3(), true, 0.17);
      const blade = mesh(new THREE.BoxGeometry(radius * 1.92, 0.005, radius * 0.16), color, id, prop); blade.rotation.y = Math.PI / 5;
      mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.014, 16), '#c3cad9', id, prop);
      group.add(label(rotor.id, '#6b7890', position.clone().add(new THREE.Vector3(0, 0.08, 0))));
    }
    for (const [direction, color, title] of [[new THREE.Vector3(0, 0, -1), '#e36167', 'F · X'], [new THREE.Vector3(1, 0, 0), '#32a181', 'R · Y'], [new THREE.Vector3(0, -1, 0), '#5687db', 'D · Z']] as const) {
      e.model.add(new THREE.ArrowHelper(direction, new THREE.Vector3(0, -0.14, 0), 0.15, color, 0.025, 0.014));
      e.model.add(label(title, color, direction.clone().multiplyScalar(0.21).add(new THREE.Vector3(0, -0.14, 0))));
    }
    e.radius = Math.max(0.46, ...ir.rotors.map(r => Math.hypot(...r.position_m) + r.prop_radius_m)) + 0.2;
  }, [irKey]);

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    if (e.replay) {
      e.scene.remove(e.replay.line);
      dispose(e.replay.line);
      e.replay = null;
    }
    e.model.position.set(0, 0, 0);
    e.model.quaternion.identity();
    e.grid.position.set(0, -0.22, 0);
    e.grid.scale.setScalar(1);
    const frames = toSceneFrames(props.replay?.frames ?? []);
    if (frames.length) {
      const positions = frames.map(frame => frame.position);
      const bounds = new THREE.Box3().setFromPoints(positions);
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = bounds.getSize(new THREE.Vector3()).length() / 2 + e.radius;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(positions), new THREE.LineBasicMaterial({ color: '#6252d2' }));
      e.scene.add(line);
      e.replay = { frames, line, center, radius };
      e.grid.position.set(center.x, 0, center.z);
      e.grid.scale.setScalar(Math.max(1, radius));
      applyReplayPose(frames, current.current.replayTime?.current ?? frames[0].time, e.model);
    }
    e.renderer.domElement.setAttribute('aria-label', frames.length ? '无人机三维飞行回放' : '无人机三维构型');
  }, [props.replay]);

  useEffect(() => { if (engine.current) fit(engine.current, current.current); }, [props.camera, props.reset, props.modelKey, props.replay]);
  return <div className="drone-canvas-wrap">
    <div className="drone-canvas" ref={host} data-webgl={unavailable ? 'unavailable' : 'ready'}/>
    {unavailable && <div className="webgl-fallback">当前设备暂不支持 WebGL。参数修订、校验与导出仍然可用。</div>}
    <div className="canvas-caption">拖拽旋转 · 滚轮缩放{props.replay ? ' · 紫线为飞行轨迹' : ' · 点击部件查参'}</div>
    <div className="axis-key"><span className="axis-f">F 前</span><span className="axis-r">R 右</span><span className="axis-d">D 下</span></div>
  </div>;
}
export default memo(Drone3DViewer);
