import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const clientDir = path.dirname( fileURLToPath( import.meta.url ) );
const threeDir = path.join( clientDir, 'node_modules/three' );

// The editor imports three.js through bare specifiers ('three', 'three/addons/...'),
// and Vite resolves those from node_modules. A few editor features also fetch three.js
// files by URL at runtime (not through import), relative to the editor page:
//   ../build/three.core.js, three.module.js, three.webgpu.js  (File > Publish, Script player)
//   ../examples/jsm/libs/draco/, ../examples/jsm/libs/basis/   (Draco / KTX2 decoders)
// The editor page (editor.html) is at the web root, so those URLs become /build/... and /examples/jsm/...
// This plugin serves them from node_modules/three, so we don't keep copies of build/ or examples/jsm.
const RUNTIME_DIRS = [ 'build', 'examples/jsm' ];

const MIME = {
	'.js': 'text/javascript',
	'.wasm': 'application/wasm',
	'.json': 'application/json',
};

function serveThreeRuntimeFiles() {

	return {
		name: 'collab3d:serve-three-runtime-files',

		configureServer( server ) {

			server.middlewares.use( ( req, res, next ) => {

				const url = decodeURIComponent( req.url.split( '?' )[ 0 ] );
				if ( ! RUNTIME_DIRS.some( ( dir ) => url.startsWith( `/${dir}/` ) ) ) return next();

				const file = path.join( threeDir, url );
				if ( ! file.startsWith( threeDir + path.sep ) ) return next();
				if ( ! fs.existsSync( file ) || ! fs.statSync( file ).isFile() ) return next();

				res.setHeader( 'Content-Type', MIME[ path.extname( file ) ] || 'application/octet-stream' );
				fs.createReadStream( file ).pipe( res );

			} );

		},

		// `npm run build`: copy everything the editor loads by URL instead of import,
		// because Vite only bundles ES module imports.
		closeBundle() {

			const outDir = path.join( clientDir, 'dist' );
			if ( ! fs.existsSync( outDir ) ) return;

			// Skips folders that don't exist (e.g. editor/examples was removed from the repo).
			const copy = ( from, to ) => {

				if ( fs.existsSync( from ) ) fs.cpSync( from, path.join( outDir, to ), { recursive: true } );

			};

			// three.js runtime files (see RUNTIME_DIRS above)
			copy( path.join( threeDir, 'build' ), 'build' );
			copy( path.join( threeDir, 'examples/jsm/libs/draco' ), 'examples/jsm/libs/draco' );
			copy( path.join( threeDir, 'examples/jsm/libs/basis' ), 'examples/jsm/libs/basis' );

			// The editor's classic <script src="js/libs/..."> tags (CodeMirror, tern, signals, ...),
			// plus js/libs/app.js and js/libs/app/index.html, which File > Publish fetches as text.
			copy( path.join( clientDir, 'editor/js/libs' ), 'js/libs' );

			// Example scenes for File > New (fetched from examples/*.app.json), if the folder is present.
			copy( path.join( clientDir, 'editor/examples' ), 'examples' );

			// Toolbar icons (Toolbar.js sets images/translate.svg etc. as <img> src at runtime).
			copy( path.join( clientDir, 'editor/images' ), 'images' );

		},
	};

}

export default defineConfig( {
	// The site's pages and the editor (editor.html) live in client/editor, so that folder is the web root (/).
	// The editor keeps its relative paths (images/, js/libs/, ../build/) because it stays in that folder.
	root: path.join( clientDir, 'editor' ),
	// Static extras the editor expects next to it (favicons, the Text menu's font).
	publicDir: path.join( clientDir, 'public' ),
	// Load env vars (VITE_*) from client/, not client/editor.
	envDir: clientDir,
	build: {
		outDir: path.join( clientDir, 'dist' ),
		emptyOutDir: true,
		// Every page of the site. Vite only builds index.html unless the others are listed here.
		rolldownOptions: {
			input: {
				home: path.join( clientDir, 'editor/index.html' ), // landing page; also where SpacetimeAuth sends you back
				login: path.join( clientDir, 'editor/login.html' ),
				servers: path.join( clientDir, 'editor/servers.html' ),
				editor: path.join( clientDir, 'editor/editor.html' ), // the 3D editor (?scene=N)
			},
		},
	},
	server: {
		port: 5173,
		strictPort: true,
	},
	plugins: [ serveThreeRuntimeFiles() ],
} );
