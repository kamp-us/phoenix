import * as THREE from "three";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {boardSlots} from "./board-layout.ts";
import type {HSBGSpectatorState} from "./hsbg-state.ts";

export interface ProjectedSlot {
	readonly key: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
}

export interface BoardScene {
	update(state: HSBGSpectatorState): void;
	hover(key: string | null): void;
	dispose(): void;
}

interface Token {
	group: THREE.Group;
	portrait: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
	shield: THREE.Mesh;
	frame: THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshStandardMaterial>;
	cardId: string;
}

function disposeTree(root: THREE.Object3D): void {
	const geometries = new Set<THREE.BufferGeometry>();
	const materials = new Set<THREE.Material>();
	const textures = new Set<THREE.Texture>();
	root.traverse((object) => {
		if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
		geometries.add(object.geometry);
		for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
			materials.add(material);
			for (const value of Object.values(material))
				if (value instanceof THREE.Texture) textures.add(value);
		}
	});
	for (const texture of textures) texture.dispose();
	for (const material of materials) material.dispose();
	for (const geometry of geometries) geometry.dispose();
}

export function createBoardScene(
	canvas: HTMLCanvasElement,
	initial: HSBGSpectatorState,
	onLayout: (slots: ReadonlyArray<ProjectedSlot>) => void,
	onAssetError: () => void,
): BoardScene {
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		powerPreference: "high-performance",
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.15;
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	const scene = new THREE.Scene();
	const camera = new THREE.OrthographicCamera(-10, 10, 6, -6, 0.1, 100);
	camera.position.set(0, 14, 10);
	camera.lookAt(0, 0, 0);
	const ambient = new THREE.HemisphereLight(0xa6c6dd, 0x362315, 2.1);
	scene.add(ambient);
	const keyLight = new THREE.DirectionalLight(0xffd29b, 3.2);
	keyLight.position.set(-6, 9, 4);
	keyLight.castShadow = true;
	keyLight.shadow.mapSize.set(1024, 1024);
	Object.assign(keyLight.shadow.camera, {left: -11, right: 11, top: 8, bottom: -8});
	keyLight.shadow.bias = -0.001;
	scene.add(keyLight);
	const coldLight = new THREE.DirectionalLight(0x7ba8df, 1.6);
	coldLight.position.set(5, 6, -5);
	scene.add(coldLight);
	const firelights = [-1, 1].map((side) => {
		const light = new THREE.PointLight(0xff9e43, 24, 8, 2);
		light.position.set(side * 8.1, 1.2, side * 3.1);
		scene.add(light);
		return light;
	});

	// A readable table remains available while the authored asset loads.
	const fallback = new THREE.Mesh(
		new THREE.BoxGeometry(18, 0.45, 10),
		new THREE.MeshStandardMaterial({color: 0x342317, roughness: 0.85}),
	);
	fallback.position.y = -0.25;
	fallback.receiveShadow = true;
	scene.add(fallback);
	let disposed = false;
	new GLTFLoader().load(
		new URL("../assets/war-table.glb", import.meta.url).href,
		(gltf) => {
			if (disposed) {
				disposeTree(gltf.scene);
				return;
			}
			gltf.scene.traverse((object) => {
				if (object instanceof THREE.Mesh) {
					object.receiveShadow = true;
					object.castShadow = true;
				}
			});
			scene.add(gltf.scene);
			fallback.visible = false;
		},
		undefined,
		() => {
			if (!disposed) onAssetError();
		},
	);

	const outline = new THREE.Shape();
	outline.absellipse(0, 0, 0.79, 0.95, 0, Math.PI * 2, false, 0);
	const hole = new THREE.Path();
	hole.absellipse(0, 0, 0.66, 0.82, 0, Math.PI * 2, true, 0);
	outline.holes.push(hole);
	const frameGeometry = new THREE.ExtrudeGeometry(outline, {
		depth: 0.1,
		bevelEnabled: true,
		bevelSegments: 2,
		steps: 1,
		bevelSize: 0.035,
		bevelThickness: 0.035,
		curveSegments: 40,
	});
	frameGeometry.rotateX(-Math.PI / 2);
	const baseGeometry = new THREE.CylinderGeometry(0.8, 0.85, 0.14, 48);
	baseGeometry.scale(1, 1, 1.18);
	const portraitGeometry = new THREE.CircleGeometry(0.665, 48);
	portraitGeometry.scale(1, 1.235, 1);
	portraitGeometry.rotateX(-Math.PI / 2);
	const shieldGeometry = new THREE.TorusGeometry(0.87, 0.025, 8, 48);
	shieldGeometry.scale(1, 1.19, 1);
	shieldGeometry.rotateX(-Math.PI / 2);
	const baseMaterial = new THREE.MeshStandardMaterial({
		color: 0x191719,
		metalness: 0.5,
		roughness: 0.65,
	});
	const shieldMaterial = new THREE.MeshBasicMaterial({
		color: 0xffd66d,
		transparent: true,
		opacity: 0.8,
	});
	const tokens = new Map<string, Token>();
	let state = initial;
	let hovered: string | null = null;
	let width = 1;
	let height = 1;
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	let motion = !reducedMotion.matches;
	const motionChanged = () => {
		motion = !reducedMotion.matches;
	};
	reducedMotion.addEventListener("change", motionChanged);

	function layout(): void {
		const project = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).project(camera);
		onLayout(
			boardSlots(state).map((slot) => {
				const p = project(slot.x, 0.32, slot.z);
				const right = project(slot.x + 0.9, 0.32, slot.z);
				return {
					key: slot.key,
					x: (p.x + 1) * 50,
					y: (1 - p.y) * 50,
					width: Math.max(76, (right.x - p.x) * width),
				};
			}),
		);
	}

	function update(next: HSBGSpectatorState): void {
		state = next;
		const slots = boardSlots(state);
		const keys = new Set(slots.filter((slot) => slot.minion).map((slot) => slot.key));
		for (const [id, token] of tokens)
			if (!keys.has(id)) {
				scene.remove(token.group);
				token.portrait.material.map?.dispose();
				token.portrait.material.dispose();
				token.frame.material.dispose();
				tokens.delete(id);
			}
		for (const slot of slots) {
			if (!slot.minion) continue;
			let token = tokens.get(slot.key);
			if (!token) {
				const group = new THREE.Group();
				const base = new THREE.Mesh(baseGeometry, baseMaterial);
				const frame = new THREE.Mesh(
					frameGeometry,
					new THREE.MeshStandardMaterial({color: 0x99733b, metalness: 0.72, roughness: 0.35}),
				);
				const portrait = new THREE.Mesh(
					portraitGeometry,
					new THREE.MeshStandardMaterial({color: 0xc8c2a9, roughness: 0.9}),
				);
				portrait.position.y = 0.135;
				frame.position.y = 0.085;
				const shield = new THREE.Mesh(shieldGeometry, shieldMaterial);
				shield.position.y = 0.22;
				group.add(base, frame, portrait, shield);
				base.castShadow = true;
				frame.castShadow = true;
				group.position.set(slot.x, 0.23, slot.z);
				scene.add(group);
				token = {group, portrait, shield, frame, cardId: ""};
				tokens.set(slot.key, token);
			}
			token.group.position.x = slot.x;
			token.group.position.z = slot.z;
			token.shield.visible = Boolean(slot.minion.divine_shield);
			token.frame.material.color.set(
				slot.minion.taunt ? 0x99aab4 : slot.minion.card_type === "SPELL" ? 0x947bb5 : 0x99733b,
			);
		}
		layout();
	}

	function resize(): void {
		width = Math.max(canvas.clientWidth, 1);
		height = Math.max(canvas.clientHeight, 1);
		renderer.setSize(width, height, false);
		const aspect = width / height;
		const viewWidth = Math.max(20, 9.2 * aspect);
		camera.left = -viewWidth / 2;
		camera.right = viewWidth / 2;
		camera.top = viewWidth / aspect / 2;
		camera.bottom = -camera.top;
		camera.updateProjectionMatrix();
		layout();
	}
	const observer = new ResizeObserver(resize);
	observer.observe(canvas);
	resize();
	update(state);
	let previous = performance.now();
	let combatBlend = initial.phase === "COMBAT" ? 1 : 0;
	let visible = true;
	const intersection = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? true;
	});
	intersection.observe(canvas);
	renderer.setAnimationLoop((time) => {
		const delta = Math.min((time - previous) / 1000, 0.1);
		previous = time;
		if (document.hidden || !visible) return;
		const target = state.phase === "COMBAT" ? 1 : 0;
		combatBlend = motion ? THREE.MathUtils.damp(combatBlend, target, 4, delta) : target;
		keyLight.intensity = 3.2 - combatBlend * 1.15;
		coldLight.intensity = 1.6 + combatBlend * 0.85;
		for (const [id, token] of tokens) {
			const active = id === hovered;
			token.group.position.y = motion
				? THREE.MathUtils.damp(token.group.position.y, active ? 0.5 : 0.23, 12, delta)
				: active
					? 0.5
					: 0.23;
			token.group.rotation.x = motion
				? THREE.MathUtils.damp(token.group.rotation.x, active ? 0.18 : 0, 12, delta)
				: 0;
		}
		for (const [index, fire] of firelights.entries())
			fire.intensity = motion ? 24 + Math.sin(time * 0.003 + index) * 2 : 24;
		renderer.render(scene, camera);
	});

	return {
		update,
		hover: (key) => {
			hovered = key;
		},
		dispose: () => {
			disposed = true;
			renderer.setAnimationLoop(null);
			observer.disconnect();
			intersection.disconnect();
			reducedMotion.removeEventListener("change", motionChanged);
			disposeTree(scene);
			frameGeometry.dispose();
			baseGeometry.dispose();
			portraitGeometry.dispose();
			shieldGeometry.dispose();
			baseMaterial.dispose();
			shieldMaterial.dispose();
			renderer.dispose();
		},
	};
}
