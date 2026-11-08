// The viewport's default look: a sky gradient over a ground that fades into the horizon, and soft daylight
// (from that sky and a low sun) instead of the editor's flat gray room. Used while the scene's Background
// and Environment are "Default" (editor/js/Viewport.js, #SPACETIME). It's never part of the scene: not
// synced, not listed, not exported, and nobody else's view changes.

import * as THREE from 'three';

// What you see
const ZENITH = new THREE.Color( 0x4f86d4 );
const HORIZON = new THREE.Color( 0xdbe7f2 );
const BELOW = new THREE.Color( 0x8e9a86 ); // under the horizon, where the ground ends
const GROUND = new THREE.Color( 0xb1bb9c );

// What lights the scene: a paler sky than the one you see (a deep blue one tints everything blue), warm
// light bouncing off the ground, and a sun bright enough to be the key light.
const LIGHT_ZENITH = new THREE.Color( 0xc4d6ee );
const LIGHT_HORIZON = new THREE.Color( 0xf4f5f4 );
const LIGHT_BELOW = new THREE.Color( 0xb9b39c );
const SUN = new THREE.Color( 0xfff0d8 );
const SUN_INTENSITY = 40;
const SUN_DIRECTION = new THREE.Vector3( 0.55, 0.62, 0.56 ).normalize(); // high in the sky, front right

const GROUND_FADE_START = 200; // meters from the camera where the ground starts fading into the haze
const GROUND_FADE_END = 2000;

const skyShader = {
	uniforms: {
		zenith: { value: ZENITH },
		horizon: { value: HORIZON },
		below: { value: BELOW },
	},
	vertexShader: /* glsl */`
		varying vec3 vDirection;
		void main() {
			vec4 world = modelMatrix * vec4( position, 1.0 );
			vDirection = world.xyz - cameraPosition;
			gl_Position = projectionMatrix * viewMatrix * world;
		}`,
	fragmentShader: /* glsl */`
		uniform vec3 zenith;
		uniform vec3 horizon;
		uniform vec3 below;
		varying vec3 vDirection;
		void main() {
			float y = normalize( vDirection ).y;
			vec3 color = y > 0.0 ? mix( horizon, zenith, pow( y, 0.55 ) ) : mix( horizon, below, pow( min( - y * 4.0, 1.0 ), 0.6 ) );
			gl_FragColor = vec4( color, 1.0 );
			#include <colorspace_fragment>
		}`,
};

const groundShader = {
	uniforms: {
		ground: { value: GROUND },
		haze: { value: HORIZON },
		fadeStart: { value: GROUND_FADE_START },
		fadeEnd: { value: GROUND_FADE_END },
	},
	vertexShader: /* glsl */`
		varying vec3 vWorld;
		void main() {
			vec4 world = modelMatrix * vec4( position, 1.0 );
			vWorld = world.xyz;
			gl_Position = projectionMatrix * viewMatrix * world;
		}`,
	fragmentShader: /* glsl */`
		uniform vec3 ground;
		uniform vec3 haze;
		uniform float fadeStart;
		uniform float fadeEnd;
		varying vec3 vWorld;
		void main() {
			float d = distance( vWorld.xz, cameraPosition.xz );
			vec3 color = mix( ground, haze, smoothstep( fadeStart, fadeEnd, d ) );
			gl_FragColor = vec4( color, 1.0 );
			#include <colorspace_fragment>
		}`,
};

export class ViewportSky {

	constructor() {

		// Drawn behind everything, before the scene, without depth: every object draws over it, so nothing
		// at y = 0 (an AI-made lawn, say) can flicker against this ground.
		this.scene = new THREE.Scene();

		this.dome = new THREE.Mesh( new THREE.SphereGeometry( 1, 32, 16 ), new THREE.ShaderMaterial( { ...skyShader, side: THREE.BackSide, depthTest: false, depthWrite: false } ) );
		this.dome.scale.setScalar( 1000 );
		this.dome.frustumCulled = false;

		this.ground = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ), new THREE.ShaderMaterial( { ...groundShader, depthTest: false, depthWrite: false } ) );
		this.ground.rotation.x = - Math.PI / 2;
		this.ground.scale.setScalar( GROUND_FADE_END * 2.2 );
		this.ground.renderOrder = 1;
		this.ground.frustumCulled = false;

		this.scene.add( this.dome, this.ground );

	}

	// Draws the sky and ground (the caller then draws the scene over them without clearing).
	render( renderer, camera ) {

		const eye = camera.getWorldPosition( this.dome.position );
		this.ground.position.set( eye.x, 0, eye.z ); // the ground goes on as far as you can see
		this.ground.visible = eye.y > 0; // from below the ground, just sky
		renderer.render( this.scene, camera );

	}

	// Lighting for the scene (scene.environment): this sky, the ground's bounce light, and a warm sun.
	environment( pmremGenerator ) {

		const scene = new THREE.Scene();

		const uniforms = { zenith: { value: LIGHT_ZENITH }, horizon: { value: LIGHT_HORIZON }, below: { value: LIGHT_BELOW } };
		const dome = new THREE.Mesh( new THREE.SphereGeometry( 50, 32, 16 ), new THREE.ShaderMaterial( { ...skyShader, uniforms, side: THREE.BackSide } ) );
		const sun = new THREE.Mesh( new THREE.SphereGeometry( 5, 16, 8 ), new THREE.MeshBasicMaterial( { color: SUN.clone().multiplyScalar( SUN_INTENSITY ) } ) );
		sun.position.copy( SUN_DIRECTION ).multiplyScalar( 40 );
		scene.add( dome, sun );

		const texture = pmremGenerator.fromScene( scene, 0.04 ).texture;
		dome.geometry.dispose();
		dome.material.dispose();
		sun.geometry.dispose();
		sun.material.dispose();
		return texture;

	}

}
