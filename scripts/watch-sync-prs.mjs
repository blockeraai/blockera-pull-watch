/**
 * Watches blockeraai repositories for "Sync package from {REPO_NAME} Repo" pull requests,
 * posts Slack notifications for new PRs, and deletes Slack messages when PRs are merged or closed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname( fileURLToPath( import.meta.url ) );
const ROOT = join( __dirname, '..' );

const GH_TOKEN = process.env.GH_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

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

async function fetchMatchingOpenPRs( repository, titlePattern ) {
	const pulls = await githubRequest(
		`/repos/${ repository }/pulls?state=open&per_page=100&sort=updated&direction=desc`
	);

	return pulls.filter( ( pr ) => titlePattern.test( pr.title ) );
}

async function fetchPullRequest( repository, prNumber ) {
	return githubRequest( `/repos/${ repository }/pulls/${ prNumber }` );
}

async function postSlackMessage( pr, repository ) {
	const status = getPRStatus( pr );
	const blocks = [
		{
			type: 'header',
			text: {
				type: 'plain_text',
				text: 'Package Sync Pull Request',
				emoji: true,
			},
		},
		{
			type: 'section',
			fields: [
				{
					type: 'mrkdwn',
					text: `*Repository:*\n\`${ repository }\``,
				},
				{
					type: 'mrkdwn',
					text: `*PR ID:*\n#${ pr.number }`,
				},
				{
					type: 'mrkdwn',
					text: `*Title:*\n${ pr.title }`,
				},
				{
					type: 'mrkdwn',
					text: `*Status:*\n${ statusEmoji( status ) }`,
				},
			],
		},
		{
			type: 'actions',
			elements: [
				{
					type: 'button',
					text: {
						type: 'plain_text',
						text: 'View Pull Request',
					},
					url: pr.html_url,
				},
			],
		},
	];

	const response = await fetch( 'https://slack.com/api/chat.postMessage', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${ SLACK_BOT_TOKEN }`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify( {
			channel: SLACK_CHANNEL_ID,
			text: `[${ repository }] #${ pr.number }: ${ pr.title } (${ status })`,
			blocks,
		} ),
	} );

	const data = await response.json();

	if ( ! data.ok ) {
		throw new Error( `Slack postMessage failed: ${ data.error }` );
	}

	return data.ts;
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

async function updateSlackMessage( pr, repository, slackTs ) {
	const status = getPRStatus( pr );
	const blocks = [
		{
			type: 'header',
			text: {
				type: 'plain_text',
				text: 'Package Sync Pull Request',
				emoji: true,
			},
		},
		{
			type: 'section',
			fields: [
				{
					type: 'mrkdwn',
					text: `*Repository:*\n\`${ repository }\``,
				},
				{
					type: 'mrkdwn',
					text: `*PR ID:*\n#${ pr.number }`,
				},
				{
					type: 'mrkdwn',
					text: `*Title:*\n${ pr.title }`,
				},
				{
					type: 'mrkdwn',
					text: `*Status:*\n${ statusEmoji( status ) }`,
				},
			],
		},
		{
			type: 'actions',
			elements: [
				{
					type: 'button',
					text: {
						type: 'plain_text',
						text: 'View Pull Request',
					},
					url: pr.html_url,
				},
			],
		},
	];

	const response = await fetch( 'https://slack.com/api/chat.update', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${ SLACK_BOT_TOKEN }`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify( {
			channel: SLACK_CHANNEL_ID,
			ts: slackTs,
			text: `[${ repository }] #${ pr.number }: ${ pr.title } (${ status })`,
			blocks,
		} ),
	} );

	const data = await response.json();

	if ( ! data.ok && data.error !== 'message_not_found' ) {
		throw new Error( `Slack chat.update failed: ${ data.error }` );
	}
}

async function main() {
	requireEnv( 'GH_TOKEN', GH_TOKEN );
	requireEnv( 'SLACK_BOT_TOKEN', SLACK_BOT_TOKEN );
	requireEnv( 'SLACK_CHANNEL_ID', SLACK_CHANNEL_ID );

	const config = loadJson( CONFIG_PATH );
	const state = loadJson( STATE_PATH );
	const titlePattern = new RegExp( config.titlePattern );
	let stateChanged = false;

	const trackedCount = Object.keys( state.messages ).length;
	console.log( `Loaded ${ trackedCount } tracked Slack message(s) from state.` );

	const trackedKeys = new Set( Object.keys( state.messages ) );
	const activeKeys = new Set();

	for ( const repository of config.repositories ) {
		console.log( `Checking ${ repository }...` );

		const openPRs = await fetchMatchingOpenPRs( repository, titlePattern );

		for ( const pr of openPRs ) {
			const key = makeStateKey( repository, pr.number );
			activeKeys.add( key );

			const status = getPRStatus( pr );
			const existing = state.messages[ key ];

			if ( ! existing ) {
				console.log(
					`New sync PR detected: ${ repository }#${ pr.number } - ${ pr.title }`
				);

				const slackTs = await postSlackMessage( pr, repository );

				state.messages[ key ] = {
					repository,
					prNumber: pr.number,
					title: pr.title,
					status,
					url: pr.html_url,
					slackTs,
					channel: SLACK_CHANNEL_ID,
					updatedAt: new Date().toISOString(),
				};
				stateChanged = true;
				continue;
			}

			if ( existing.status !== status || existing.title !== pr.title ) {
				console.log(
					`Updating sync PR status: ${ repository }#${ pr.number } (${ existing.status } -> ${ status })`
				);

				await updateSlackMessage( pr, repository, existing.slackTs );

				state.messages[ key ] = {
					...existing,
					title: pr.title,
					status,
					url: pr.html_url,
					updatedAt: new Date().toISOString(),
				};
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

			if ( tracked.status !== status || tracked.title !== pr.title ) {
				await updateSlackMessage( pr, tracked.repository, tracked.slackTs );

				state.messages[ key ] = {
					...tracked,
					title: pr.title,
					status,
					url: pr.html_url,
					updatedAt: new Date().toISOString(),
				};
				stateChanged = true;
			}

			continue;
		}

		if ( status === 'closed' ) {
			if ( tracked.status !== status || tracked.title !== pr.title ) {
				console.log(
					`Updating closed sync PR: ${ tracked.repository }#${ tracked.prNumber }`
				);

				await updateSlackMessage( pr, tracked.repository, tracked.slackTs );

				state.messages[ key ] = {
					...tracked,
					title: pr.title,
					status,
					url: pr.html_url,
					updatedAt: new Date().toISOString(),
				};
				stateChanged = true;
			}

			continue;
		}

		console.log(
			`Removing Slack message for merged PR ${ tracked.repository }#${ tracked.prNumber }`
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
