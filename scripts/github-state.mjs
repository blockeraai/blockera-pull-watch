/**
 * Shared helpers for reading and writing slack-messages.json via GitHub API.
 */

const FILE_PATH = 'data/slack-messages.json';

export function normalizeState( state ) {
	return `${ JSON.stringify( state, null, '\t' ) }\n`;
}

export function mergeStates( remoteState, localState ) {
	return {
		messages: {
			...( remoteState?.messages || {} ),
			...( localState?.messages || {} ),
		},
	};
}

export async function githubRequest( token, path, options = {} ) {
	const response = await fetch( `https://api.github.com${ path }`, {
		...options,
		headers: {
			Authorization: `Bearer ${ token }`,
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

export async function fetchRemoteState( {
	token,
	repository,
	branch = 'master',
} ) {
	const [ owner, repo ] = repository.split( '/' );
	const { response, data } = await githubRequest(
		token,
		`/repos/${ owner }/${ repo }/contents/${ FILE_PATH }?ref=${ branch }`
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

export async function pushRemoteState( {
	token,
	repository,
	branch = 'master',
	state,
	sha,
	message,
} ) {
	const [ owner, repo ] = repository.split( '/' );
	const body = {
		message,
		content: Buffer.from( normalizeState( state ) ).toString( 'base64' ),
		branch,
	};

	if ( sha ) {
		body.sha = sha;
	}

	const { response, data } = await githubRequest(
		token,
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
