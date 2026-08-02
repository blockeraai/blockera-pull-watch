/**
 * Watches blockeraai repositories for "Sync package from {REPO_NAME} Repo" pull requests,
 * posts Slack notifications for new PRs, and deletes Slack messages when PRs are merged or closed.
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

	return data.ok;
}

function buildStateEntry( pr, repository, slackTs, existing = {} ) {
	return {
		...existing,
		repository,
		prNumber: pr.number,
		title: pr.title,
		status: getPRStatus( pr ),
		url: pr.html_url,
		slackTs,
		channel: SLACK_CHANNEL_ID,
		updatedAt: new Date().toISOString(),
	};
}

async function syncTrackedSlackMessage( pr, repository, existing ) {
	const channel = existing.channel || SLACK_CHANNEL_ID;
	const status = getPRStatus( pr );
	const messageExists = await slackMessageExists( channel, existing.slackTs );

	if ( ! messageExists ) {
		console.log(
			`Slack message missing for ${ repository }#${ pr.number }, reposting...`
		);

		const slackTs = await postSlackMessage( pr, repository );

		return {
			changed: true,
			entry: buildStateEntry( pr, repository, slackTs, existing ),
		};
	}

	if ( existing.status !== status || existing.title !== pr.title ) {
		console.log(
			`Updating sync PR status: ${ repository }#${ pr.number } (${ existing.status } -> ${ status })`
		);

		await updateSlackMessage( pr, repository, existing.slackTs );

		return {
			changed: true,
			entry: buildStateEntry( pr, repository, existing.slackTs, existing ),
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
	const titlePattern = new RegExp( config.titlePattern );
	let stateChanged = false;

	const trackedKeys = new Set( Object.keys( state.messages ) );
	const activeKeys = new Set();

	for ( const repository of config.repositories ) {
		console.log( `Checking ${ repository }...` );

		const openPRs = await fetchMatchingOpenPRs( repository, titlePattern );

		for ( const pr of openPRs ) {
			const key = makeStateKey( repository, pr.number );
			activeKeys.add( key );

			const existing = state.messages[ key ];

			if ( ! existing ) {
				console.log(
					`New sync PR detected: ${ repository }#${ pr.number } - ${ pr.title }`
				);

				const slackTs = await postSlackMessage( pr, repository );

				state.messages[ key ] = buildStateEntry(
					pr,
					repository,
					slackTs
				);
				stateChanged = true;
				continue;
			}

			const synced = await syncTrackedSlackMessage(
				pr,
				repository,
				existing
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
				tracked
			);

			if ( synced.changed ) {
				state.messages[ key ] = synced.entry;
				stateChanged = true;
			}

			continue;
		}

		if ( status === 'closed' ) {
			const channel = tracked.channel || SLACK_CHANNEL_ID;
			const messageExists = await slackMessageExists(
				channel,
				tracked.slackTs
			);

			if (
				messageExists &&
				( tracked.status !== status || tracked.title !== pr.title )
			) {
				console.log(
					`Updating closed sync PR: ${ tracked.repository }#${ tracked.prNumber }`
				);

				await updateSlackMessage( pr, tracked.repository, tracked.slackTs );

				state.messages[ key ] = buildStateEntry(
					pr,
					tracked.repository,
					tracked.slackTs,
					tracked
				);
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
