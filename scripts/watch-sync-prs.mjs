/**
 * Watches blockeraai repositories for package-sync PRs (folder-sync titles and
 * global-packages bump PRs from sync-global-packages-submodule), posts Slack
 * notifications, and deletes Slack messages when those PRs are merged or closed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRemoteState, mergeStates } from './github-state.mjs';

const __dirname = dirname( fileURLToPath( import.meta.url ) );
const ROOT = join( __dirname, '..' );

const GH_TOKEN = process.env.GH_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const GITHUB_REPOSITORY =
	process.env.GITHUB_REPOSITORY || 'blockeraai/blockera-pull-watch';
const GITHUB_REF_NAME = process.env.GITHUB_REF_NAME || 'master';

const STATE_PATH = join( ROOT, 'data', 'slack-messages.json' );
const CONFIG_PATH = join( ROOT, 'config', 'repositories.json' );

function requireEnv( name, value ) {
	if ( ! value ) {
		throw new Error( `Missing required environment variable: ${ name }` );
	}
}

function loadJson( path ) {
	return JSON.parse( readFileSync( path, 'utf8' ) );
}

function saveState( state ) {
	writeFileSync( STATE_PATH, `${ JSON.stringify( state, null, '\t' ) }\n` );
}

async function loadState() {
	const fileState = loadJson( STATE_PATH );

	try {
		const { sha, state: remoteState } = await fetchRemoteState( {
			token: GH_TOKEN,
			repository: GITHUB_REPOSITORY,
			branch: GITHUB_REF_NAME,
		} );

		const mergedState = mergeStates( remoteState, fileState );
		const trackedCount = Object.keys( mergedState.messages ).length;

		console.log(
			`Loaded ${ trackedCount } tracked Slack message(s) from remote state (${ sha?.slice( 0, 7 ) || 'new' }).`
		);

		saveState( mergedState );

		return mergedState;
	} catch ( error ) {
		const trackedCount = Object.keys( fileState.messages ).length;

		console.warn(
			`Could not fetch remote state (${ error.message }), using local file with ${ trackedCount } message(s).`
		);

		return fileState;
	}
}

function makeStateKey( repository, prNumber ) {
	return `${ repository }#${ prNumber }`;
}

function getPRStatus( pr ) {
	if ( pr.merged_at ) {
		return 'merged';
	}

	if ( pr.state === 'closed' ) {
		return 'closed';
	}

	return 'open';
}

function statusEmoji( status ) {
	switch ( status ) {
		case 'merged':
			return ':white_check_mark: Merged';
		case 'closed':
			return ':x: Closed';
		default:
			return ':large_blue_circle: Open';
	}
}

async function githubRequest( path ) {
	const response = await fetch( `https://api.github.com${ path }`, {
		headers: {
			Authorization: `Bearer ${ GH_TOKEN }`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
		},
	} );

	if ( ! response.ok ) {
		const body = await response.text();
		throw new Error(
			`GitHub API request failed (${ response.status }) for ${ path }: ${ body }`
		);
	}

	return response.json();
}

function compileMatchers( config ) {
	const raw =
		Array.isArray( config.matchers ) && config.matchers.length
			? config.matchers
			: [
					{
						id: 'folder-sync',
						titlePattern: config.titlePattern,
						slackHeader: 'Package Sync Pull Request',
					},
			  ];

	return raw.map( ( matcher ) => ( {
		id: matcher.id || 'sync',
		head: matcher.head || '',
		titlePattern: matcher.titlePattern
			? new RegExp( matcher.titlePattern )
			: null,
		slackHeader: matcher.slackHeader || 'Package Sync Pull Request',
	} ) );
}

function findMatcher( pr, matchers ) {
	return (
		matchers.find( ( matcher ) => {
			if ( matcher.head && pr.head?.ref === matcher.head ) {
				return true;
			}

			if (
				matcher.titlePattern &&
				matcher.titlePattern.test( pr.title )
			) {
				return true;
			}

			return false;
		} ) || null
	);
}

function slackHeaderFor( pr, matchers, existing = {} ) {
	const matcher = findMatcher( pr, matchers );

	return (
		existing.slackHeader ||
		matcher?.slackHeader ||
		'Package Sync Pull Request'
	);
}

function productSlug( repository ) {
	return ( repository || '' ).split( '/' )[ 1 ] || repository;
}

function slackEscape( text ) {
	return String( text || '' )
		.replaceAll( '&', '&amp;' )
		.replaceAll( '<', '&lt;' )
		.replaceAll( '>', '&gt;' );
}

function slackField( label, value ) {
	return {
		type: 'mrkdwn',
		text: `*${ label }*\n${ value }`,
	};
}

function parseGpPinFromBody( body ) {
	const match = String( body || '' ).match(
		/packages\/global-packages` to \[`([a-f0-9]+)`\]\((https:\/\/github\.com\/[^)\s]+)\)/
	);

	if ( ! match ) {
		return { sha: '', url: '' };
	}

	return { sha: match[ 1 ], url: match[ 2 ] };
}

function buildSlackPayload( pr, repository, matchers, existing = {} ) {
	const matcher = findMatcher( pr, matchers );
	const status = getPRStatus( pr );
	const header = slackHeaderFor( pr, matchers, existing );
	const product = productSlug( repository );
	const head = pr.head?.ref ? `\`${ slackEscape( pr.head.ref ) }\`` : '—';
	const base = pr.base?.ref ? `\`${ slackEscape( pr.base.ref ) }\`` : '—';
	const author = pr.user?.login
		? `\`${ slackEscape( pr.user.login ) }\``
		: '—';
	const prLink = `<${ pr.html_url }|#${ pr.number }>`;
	const isGp = matcher?.id === 'global-packages';
	const pin = parseGpPinFromBody( pr.body );
	const pinLabel = pin.sha
		? pin.url
			? `<${ pin.url }|\`${ slackEscape( pin.sha ) }\`>`
			: `\`${ slackEscape( pin.sha ) }\``
		: '—';

	const intro = isGp
		? `*${ slackEscape( product ) }* needs a \`packages/global-packages\` pin review. Merge when CI is green — later GP \`master\` commits update this same PR.`
		: `*${ slackEscape( product ) }* has a package-sync PR ready for review.`;

	const fields = isGp
		? [
				slackField( 'Consumer', `\`${ slackEscape( repository ) }\`` ),
				slackField( 'Pull request', prLink ),
				slackField( 'Head', head ),
				slackField( 'GP pin', pinLabel ),
				slackField( 'Base', base ),
				slackField( 'Opened by', author ),
				slackField( 'Status', statusEmoji( status ) ),
				slackField(
					'Draft',
					pr.draft ? ':large_yellow_circle: Yes' : ':white_circle: No'
				),
		  ]
		: [
				slackField( 'Repository', `\`${ slackEscape( repository ) }\`` ),
				slackField( 'Pull request', prLink ),
				slackField( 'Title', slackEscape( pr.title ) ),
				slackField( 'Status', statusEmoji( status ) ),
		  ];

	const actions = [
		{
			type: 'button',
			style: 'primary',
			text: {
				type: 'plain_text',
				text: isGp ? 'Review pin PR' : 'View Pull Request',
				emoji: true,
			},
			url: pr.html_url,
		},
	];

	if ( isGp ) {
		actions.push( {
			type: 'button',
			text: { type: 'plain_text', text: 'Checks', emoji: true },
			url: `${ pr.html_url }/checks`,
		} );

		if ( pin.url ) {
			actions.push( {
				type: 'button',
				text: { type: 'plain_text', text: 'GP commit', emoji: true },
				url: pin.url,
			} );
		}
	}

	const blocks = [
		{
			type: 'header',
			text: {
				type: 'plain_text',
				text: isGp ? 'Global Packages pin' : header,
				emoji: true,
			},
		},
		{
			type: 'section',
			text: { type: 'mrkdwn', text: intro },
		},
		{ type: 'section', fields },
		{ type: 'divider' },
		{
			type: 'context',
			elements: [
				{
					type: 'mrkdwn',
					text: isGp
						? ':package: `sync-global-packages-submodule` · one bump PR per consumer'
						: ':inbox_tray: folder-sync package PR',
				},
			],
		},
		{ type: 'actions', elements: actions },
	];

	const text = isGp
		? `[${ product }] GP pin ${ prLink } (${ status })`
		: `[${ repository }] #${ pr.number }: ${ pr.title } (${ status })`;

	return { text, blocks, header };
}

async function fetchMatchingOpenPRs( repository, matchers ) {
	const pulls = await githubRequest(
		`/repos/${ repository }/pulls?state=open&per_page=100&sort=updated&direction=desc`
	);

	return pulls.filter( ( pr ) => findMatcher( pr, matchers ) );
}

async function fetchPullRequest( repository, prNumber ) {
	return githubRequest( `/repos/${ repository }/pulls/${ prNumber }` );
}

async function postSlackMessage( pr, repository, matchers, existing = {} ) {
	const payload = buildSlackPayload( pr, repository, matchers, existing );

	const response = await fetch( 'https://slack.com/api/chat.postMessage', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${ SLACK_BOT_TOKEN }`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify( {
			channel: SLACK_CHANNEL_ID,
			text: payload.text,
			blocks: payload.blocks,
		} ),
	} );

	const data = await response.json();

	if ( ! data.ok ) {
		throw new Error( `Slack postMessage failed: ${ data.error }` );
	}

	return data.ts;
}

async function slackMessageExists( channel, slackTs ) {
	const response = await fetch( 'https://slack.com/api/conversations.history', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${ SLACK_BOT_TOKEN }`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify( {
			channel,
			oldest: slackTs,
			latest: slackTs,
			inclusive: true,
			limit: 1,
		} ),
	} );

	const data = await response.json();

	if ( ! data.ok ) {
		throw new Error(
			`Slack conversations.history failed: ${ data.error }`
		);
	}

	return (
		data.messages?.some( ( message ) => message.ts === slackTs ) ?? false
	);
}

async function deleteSlackMessage( slackTs ) {
	const response = await fetch( 'https://slack.com/api/chat.delete', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${ SLACK_BOT_TOKEN }`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify( {
			channel: SLACK_CHANNEL_ID,
			ts: slackTs,
		} ),
	} );

	const data = await response.json();

	if ( ! data.ok && data.error !== 'message_not_found' ) {
		throw new Error( `Slack chat.delete failed: ${ data.error }` );
	}
}

async function updateSlackMessage( pr, repository, slackTs, matchers, existing = {} ) {
	const payload = buildSlackPayload( pr, repository, matchers, existing );

	const response = await fetch( 'https://slack.com/api/chat.update', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${ SLACK_BOT_TOKEN }`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify( {
			channel: SLACK_CHANNEL_ID,
			ts: slackTs,
			text: payload.text,
			blocks: payload.blocks,
		} ),
	} );

	const data = await response.json();

	if ( ! data.ok && data.error !== 'message_not_found' ) {
		throw new Error( `Slack chat.update failed: ${ data.error }` );
	}

	return data.ok;
}

function buildStateEntry(
	pr,
	repository,
	slackTs,
	existing = {},
	slackHeader
) {
	return {
		...existing,
		repository,
		prNumber: pr.number,
		title: pr.title,
		head: pr.head?.ref || existing.head || '',
		gpPin: parseGpPinFromBody( pr.body ).sha,
		draft: Boolean( pr.draft ),
		status: getPRStatus( pr ),
		url: pr.html_url,
		slackTs,
		channel: SLACK_CHANNEL_ID,
		slackHeader:
			slackHeader ||
			existing.slackHeader ||
			'Package Sync Pull Request',
		layoutVersion: 2,
		updatedAt: new Date().toISOString(),
	};
}

async function syncTrackedSlackMessage( pr, repository, existing, matchers ) {
	const channel = existing.channel || SLACK_CHANNEL_ID;
	const status = getPRStatus( pr );
	const header = slackHeaderFor( pr, matchers, existing );
	const messageExists = await slackMessageExists( channel, existing.slackTs );

	if ( ! messageExists ) {
		console.log(
			`Slack message missing for ${ repository }#${ pr.number }, reposting...`
		);

		const slackTs = await postSlackMessage(
			pr,
			repository,
			matchers,
			existing
		);

		return {
			changed: true,
			entry: buildStateEntry( pr, repository, slackTs, existing, header ),
		};
	}

	const pinSha = parseGpPinFromBody( pr.body ).sha;

	if (
		existing.status !== status ||
		existing.title !== pr.title ||
		existing.head !== ( pr.head?.ref || existing.head || '' ) ||
		existing.gpPin !== pinSha ||
		Boolean( existing.draft ) !== Boolean( pr.draft ) ||
		existing.layoutVersion !== 2
	) {
		console.log(
			`Updating sync PR status: ${ repository }#${ pr.number } (${ existing.status } -> ${ status })`
		);

		await updateSlackMessage(
			pr,
			repository,
			existing.slackTs,
			matchers,
			existing
		);

		return {
			changed: true,
			entry: buildStateEntry(
				pr,
				repository,
				existing.slackTs,
				existing,
				header
			),
		};
	}

	return {
		changed: false,
		entry: existing,
	};
}

async function main() {
	requireEnv( 'GH_TOKEN', GH_TOKEN );
	requireEnv( 'SLACK_BOT_TOKEN', SLACK_BOT_TOKEN );
	requireEnv( 'SLACK_CHANNEL_ID', SLACK_CHANNEL_ID );

	const config = loadJson( CONFIG_PATH );
	const state = await loadState();
	const matchers = compileMatchers( config );
	let stateChanged = false;

	const trackedKeys = new Set( Object.keys( state.messages ) );
	const activeKeys = new Set();

	for ( const repository of config.repositories ) {
		console.log( `Checking ${ repository }...` );

		const openPRs = await fetchMatchingOpenPRs( repository, matchers );

		for ( const pr of openPRs ) {
			const key = makeStateKey( repository, pr.number );
			activeKeys.add( key );

			const existing = state.messages[ key ];
			const header = slackHeaderFor( pr, matchers, existing );

			if ( ! existing ) {
				console.log(
					`New sync PR detected: ${ repository }#${ pr.number } - ${ pr.title }`
				);

				const slackTs = await postSlackMessage(
					pr,
					repository,
					matchers,
					existing
				);

				state.messages[ key ] = buildStateEntry(
					pr,
					repository,
					slackTs,
					{},
					header
				);
				stateChanged = true;
				continue;
			}

			const synced = await syncTrackedSlackMessage(
				pr,
				repository,
				existing,
				matchers
			);

			if ( synced.changed ) {
				state.messages[ key ] = synced.entry;
				stateChanged = true;
			}
		}
	}

	for ( const key of trackedKeys ) {
		if ( activeKeys.has( key ) ) {
			continue;
		}

		const tracked = state.messages[ key ];
		const pr = await fetchPullRequest( tracked.repository, tracked.prNumber );
		const status = getPRStatus( pr );

		if ( status === 'open' ) {
			activeKeys.add( key );

			const synced = await syncTrackedSlackMessage(
				pr,
				tracked.repository,
				tracked,
				matchers
			);

			if ( synced.changed ) {
				state.messages[ key ] = synced.entry;
				stateChanged = true;
			}

			continue;
		}

		console.log(
			`Removing Slack message for ${ status } PR ${ tracked.repository }#${ tracked.prNumber }`
		);

		await deleteSlackMessage( tracked.slackTs );
		delete state.messages[ key ];
		stateChanged = true;
	}

	if ( stateChanged ) {
		saveState( state );
		console.log( 'State updated.' );
	} else {
		console.log( 'No changes detected.' );
	}
}

main().catch( ( error ) => {
	console.error( error );
	process.exit( 1 );
} );
