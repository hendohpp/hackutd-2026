// Standalone Gemini test for the AI teammate. Not used by the app.
//
//   node ai-proto/ask.mjs "build a campfire"
//
// Reads GEMINI_API_KEY from ai-proto/.env (git-ignored). No dependencies.
// Uses the Gemini Interactions API with a JSON schema (structured output).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname( fileURLToPath( import.meta.url ) );
try {
	process.loadEnvFile( path.join( here, '.env' ) );
} catch {
	// no .env file: fall back to the shell environment
}

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'; // fast (~3s); override in .env
const KINDS = [ 'box', 'sphere', 'cylinder', 'plane' ];
const MAX_OBJECTS = 20;
const MAX_POS = 5;
const MIN_SIZE = 0.1;
const MAX_SIZE = 10;
const DEFAULT_COLOR = '#888888';
const COLOR_RE = /^#[0-9a-f]{6}$/; // same "#rrggbb" rule as the server's validate_color

const userPrompt = process.argv.slice( 2 ).join( ' ' ).trim();
if ( ! userPrompt ) {
	console.error( 'usage: node ai-proto/ask.mjs "build a campfire"' );
	process.exit( 1 );
}
if ( ! KEY ) {
	console.error( 'GEMINI_API_KEY is missing. Put it in ai-proto/.env (see ai-proto/.env.example).' );
	process.exit( 1 );
}

// The schema Gemini must follow. We still re-check everything below,
// because the model's output is untrusted.
const num = ( min, max ) => ( { type: 'number', minimum: min, maximum: max } );
const schema = {
	type: 'object',
	properties: {
		actions: {
			type: 'array',
			maxItems: MAX_OBJECTS,
			items: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: KINDS },
					color: { type: 'string', description: 'hex color like #ff8800' },
					px: num( - MAX_POS, MAX_POS ),
					py: num( - MAX_POS, MAX_POS ),
					pz: num( - MAX_POS, MAX_POS ),
					sx: num( MIN_SIZE, MAX_SIZE ),
					sy: num( MIN_SIZE, MAX_SIZE ),
					sz: num( MIN_SIZE, MAX_SIZE ),
				},
				required: [ 'kind', 'color', 'px', 'py', 'pz', 'sx', 'sy', 'sz' ],
			},
		},
	},
	required: [ 'actions' ],
};

const instructions = `You are an AI teammate in a shared 3D editor. Build this using simple shapes: "${userPrompt}"
Rules:
- Y is up. The ground is y = 0. Units are meters.
- Each object has a kind (box, sphere, cylinder, plane), a color (#rrggbb), a center position (px, py, pz) and a size (sx, sy, sz).
- Size 1 means a 1 meter shape. Rest objects on the ground: a box 1 m tall has py = 0.5.
- A plane is a flat horizontal surface lying on the ground.
- Keep every position between -${MAX_POS} and ${MAX_POS}. Use at most ${MAX_OBJECTS} objects.`;

const res = await fetch( 'https://generativelanguage.googleapis.com/v1beta/interactions', {
	method: 'POST',
	headers: {
		'x-goog-api-key': KEY,
		'Content-Type': 'application/json',
		'Api-Revision': '2026-05-20',
	},
	body: JSON.stringify( {
		model: MODEL,
		input: instructions,
		response_format: { type: 'text', mime_type: 'application/json', schema },
	} ),
	signal: AbortSignal.timeout( 60_000 ),
} ).catch( ( err ) => fail( err.name === 'TimeoutError'
	? `Gemini (${MODEL}) did not answer within 60s. It may be overloaded: try again, or set GEMINI_MODEL in ai-proto/.env.`
	: `Could not reach Gemini: ${err.message}` ) );

const raw = await res.text();
if ( ! res.ok ) fail( `Gemini returned HTTP ${res.status}:\n${raw}` );

const text = getText( JSON.parse( raw ) );
if ( ! text ) fail( `Could not find the JSON text in Gemini's response:\n${raw}` );

let parsed;
try {
	parsed = JSON.parse( text );
} catch {
	fail( `Gemini's text was not valid JSON:\n${text}` );
}

console.log( JSON.stringify( { actions: validate( parsed.actions ) } ) );

function fail( message ) {
	console.error( message );
	process.exit( 1 );
}

// The model's text lives in steps[] -> { type: "model_output", content: [ { type: "text", text } ] }.
// (Other steps, like type "thought", are skipped.)
function getText( data ) {
	for ( const step of data.steps ?? [] ) {
		if ( step.type !== 'model_output' ) continue;
		for ( const part of step.content ?? [] ) {
			if ( part.type === 'text' && typeof part.text === 'string' ) return part.text;
		}
	}
	return null;
}

// Keep only allowed kinds, fix bad colors, clamp every number, cap the count.
function validate( actions ) {
	if ( ! Array.isArray( actions ) ) return [];
	const clamp = ( v, min, max ) => Math.min( max, Math.max( min, Number.isFinite( v ) ? v : 0 ) );
	const color = ( c ) => ( typeof c === 'string' && COLOR_RE.test( c.toLowerCase() ) ? c.toLowerCase() : DEFAULT_COLOR );
	return actions
		.filter( ( a ) => a && KINDS.includes( a.kind ) )
		.slice( 0, MAX_OBJECTS )
		.map( ( a ) => ( {
			kind: a.kind,
			color: color( a.color ),
			px: clamp( a.px, - MAX_POS, MAX_POS ),
			py: clamp( a.py, - MAX_POS, MAX_POS ),
			pz: clamp( a.pz, - MAX_POS, MAX_POS ),
			sx: clamp( a.sx, MIN_SIZE, MAX_SIZE ),
			sy: clamp( a.sy, MIN_SIZE, MAX_SIZE ),
			sz: clamp( a.sz, MIN_SIZE, MAX_SIZE ),
		} ) );
}
