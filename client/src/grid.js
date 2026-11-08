// The viewport's ground grid, built from short pieces rather than one line per row (THREE.GridHelper).
// A line that runs far behind the camera can be dropped whole by some renderers (Chrome's software
// renderer does): once the grid grew to 200 m, every line running away from you vanished while you stood
// inside it. Short pieces clip cleanly anywhere. Same look as GridHelper: set material.color.

import * as THREE from 'three';

export function segmentedGrid( size, divisions, piece = 5 ) {

	const half = size / 2;
	const step = size / divisions;
	const positions = [];

	for ( let i = 0; i <= divisions; i ++ ) {

		const k = - half + i * step;

		for ( let a = - half; a < half - 1e-6; a += piece ) {

			const b = Math.min( a + piece, half );
			positions.push( a, 0, k, b, 0, k ); // along x
			positions.push( k, 0, a, k, 0, b ); // along z

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	return new THREE.LineSegments( geometry, new THREE.LineBasicMaterial( { toneMapped: false } ) );

}
