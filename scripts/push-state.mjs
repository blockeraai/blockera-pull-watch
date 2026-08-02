/**
 * Push slack-messages.json via GitHub Contents API with remote merge + retry.
 * Avoids git push races when master receives commits during workflow runs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname( fileURLToPath( import.meta.url ) );
const ROOT = join( __dirname, '..' );
const STATE_PATH = join( ROOT, 'data', 'slack-messages.json' );

const GH_TOKEN = process.env.GH_TOKEN;
const REPOSITORY = process.env.GITHUB_REPOSITORY || 'blockeraai/blockera-pull-watch';
const BRANCH = process.env.GITHUB_REF_NAME || 'master';
const FILE_PATH = 'data/slack-messages.json';
const COMMIT_MESSAGE = 'chore: update sync PR Slack message state';

function requireEnv( name, value ) {
	if ( ! value ) {
		throw new Error( `Missing required environment variable: ${ name }` );
	}
}

function loadLocalState() {
	return JSON.parse( readFileSync( STATE_PATH, 'utf8' ) );
}

function normalizeState( state ) {
	return `${ JSON.stringify( state, null, '\t' ) }\n`;
}

function mergeStates( remoteState, localState ) {
	return {
		messages: {
			...( remoteState?.messages || {} ),
			...( localState?.messages || {} ),
		},
	};
}

async function githubRequest( path, options = {} ) {
	const response = await fetch( `https://api.github.com${ path }`, {
		...options,
		headers: {
			Authorization: `Bearer ${ GH_TOKEN }`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			...( options.headers || {} ),
		},
	} );

	const text = await response.text();
	let data = {};

	if ( text ) {
		data = JSON.parse( text );
	}

	return { response, data };
}

async function fetchRemoteState() {
	const [ owner, repo ] = REPOSITORY.split( '/' );
	const { response, data } = await githubRequest(
		`/repos/${ owner }/${ repo }/contents/${ FILE_PATH }?ref=${ BRANCH }`
	);

	if ( response.status === 404 ) {
		return { sha: null, state: { messages: {} } };
	}

	if ( ! response.ok ) {
		throw new Error(
			`Failed to fetch remote state (${ response.status }): ${ JSON.stringify( data ) }`
		);
	}

	const content = Buffer.from( data.content, 'base64' ).toString( 'utf8' );

	return {
		sha: data.sha,
		state: JSON.parse( content ),
	};
}

async function pushState( state, sha ) {
	const [ owner, repo ] = REPOSITORY.split( '/' );
	const body = {
		message: COMMIT_MESSAGE,
		content: Buffer.from( normalizeState( state ) ).toString( 'base64' ),
		branch: BRANCH,
	};

	if ( sha ) {
		body.sha = sha;
	}

	const { response, data } = await githubRequest(
		`/repos/${ owner }/${ repo }/contents/${ FILE_PATH }`,
		{
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify( body ),
		}
	);

	return { response, data };
}

async function main() {
	requireEnv( 'GH_TOKEN', GH_TOKEN );

	const localState = loadLocalState();
	const maxAttempts = 5;

	for ( let attempt = 1; attempt <= maxAttempts; attempt++ ) {
		const { sha, state: remoteState } = await fetchRemoteState();
		const mergedState = mergeStates( remoteState, localState );

		if ( normalizeState( mergedState ) === normalizeState( remoteState ) ) {
			console.log( 'Remote state is already up to date.' );
			return;
		}

		const { response, data } = await pushState( mergedState, sha );

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
