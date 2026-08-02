/**
 * Push slack-messages.json via GitHub Contents API with remote merge + retry.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	fetchRemoteState,
	mergeStates,
	normalizeState,
	pushRemoteState,
} from './github-state.mjs';

const __dirname = dirname( fileURLToPath( import.meta.url ) );
const ROOT = join( __dirname, '..' );
const STATE_PATH = join( ROOT, 'data', 'slack-messages.json' );

const GH_TOKEN = process.env.GH_TOKEN;
const REPOSITORY = process.env.GITHUB_REPOSITORY || 'blockeraai/blockera-pull-watch';
const BRANCH = process.env.GITHUB_REF_NAME || 'master';
const COMMIT_MESSAGE = 'bot(watch): update slack message state';

function requireEnv( name, value ) {
	if ( ! value ) {
		throw new Error( `Missing required environment variable: ${ name }` );
	}
}

function loadLocalState() {
	return JSON.parse( readFileSync( STATE_PATH, 'utf8' ) );
}

async function main() {
	requireEnv( 'GH_TOKEN', GH_TOKEN );

	const localState = loadLocalState();
	const maxAttempts = 5;

	for ( let attempt = 1; attempt <= maxAttempts; attempt++ ) {
		const { sha, state: remoteState } = await fetchRemoteState( {
			token: GH_TOKEN,
			repository: REPOSITORY,
			branch: BRANCH,
		} );
		const mergedState = mergeStates( remoteState, localState );

		if ( normalizeState( mergedState ) === normalizeState( remoteState ) ) {
			console.log( 'Remote state is already up to date.' );
			return;
		}

		const { response, data } = await pushRemoteState( {
			token: GH_TOKEN,
			repository: REPOSITORY,
			branch: BRANCH,
			state: mergedState,
			sha,
			message: COMMIT_MESSAGE,
		} );

		if ( response.ok ) {
			console.log( `State pushed successfully on attempt ${ attempt }.` );
			return;
		}

		if ( response.status === 409 && attempt < maxAttempts ) {
			console.log(
				`Remote state changed during push (attempt ${ attempt }), retrying...`
			);
			await new Promise( ( resolve ) => setTimeout( resolve, 2000 ) );
			continue;
		}

		throw new Error(
			`Failed to push state (${ response.status }): ${ JSON.stringify( data ) }`
		);
	}
}

main().catch( ( error ) => {
	console.error( error );
	process.exit( 1 );
} );
