// Buffer GraphQL API client
// Endpoint: https://api.buffer.com
// Auth: Bearer token

const https = require('https');

const BUFFER_TOKEN = process.env.BUFFER_ACCESS_TOKEN || 'l-fUTqjQKsxfzZiX8xehcNGayZ0gITNj7t8Y48SKGXX';

function gqlRequest(query, variables = {}, token = BUFFER_TOKEN) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const options = {
      hostname: 'api.buffer.com',
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) reject(new Error(json.errors[0]?.message || 'GraphQL error'));
          else resolve(json.data);
        } catch { reject(new Error('Invalid response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Get account + organization ID
async function getAccount(token) {
  const data = await gqlRequest(`
    query {
      account {
        id
        name
        email
        organizations {
          id
          name
        }
      }
    }
  `, {}, token);
  return data.account;
}

// Get all connected channels (social profiles)
async function getChannels(token) {
  const account = await getAccount(token);
  const orgId = account?.organizations?.[0]?.id;
  if (!orgId) throw new Error('No organization found');

  const data = await gqlRequest(`
    query GetChannels($input: ChannelsInput!) {
      channels(input: $input) {
        id
        name
        service
        serviceId
        avatar
        timezone
        isQueuePaused
      }
    }
  `, { input: { organizationId: orgId } }, token);
  return { channels: data.channels || [], orgId };
}

// Create a scheduled post on a single channel
// channelId: single channel ID string
// text: caption
// videoUrl: public URL to video
// scheduledAt: ISO 8601 timestamp (for customScheduled mode)
async function createPost(token, orgId, channelId, text, videoUrl, scheduledAt, saveToDraft = false) {
  const input = {
    channelId,
    text,
    schedulingType: 'automatic',
    mode: scheduledAt ? 'customScheduled' : 'addToQueue',
    source: 'clipflow',
    aiAssisted: false,
  };
  if (scheduledAt) input.dueAt = scheduledAt;
  // Always include video asset (required for TikTok even in draft)
  if (videoUrl) {
    input.assets = { videos: [{ url: videoUrl }] };
  }
  if (saveToDraft) {
    input.saveToDraft = true;
    input.mode = 'addToQueue';
    delete input.dueAt;
  }

  console.log('[Buffer.createPost] input:', JSON.stringify(input, null, 2));
  const data = await gqlRequest(`
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post { id text status dueAt }
        }
        ... on NotFoundError { message }
        ... on UnauthorizedError { message }
        ... on InvalidInputError { message }
        ... on LimitReachedError { message }
        ... on RestProxyError { message code }
        ... on UnexpectedError { message }
      }
    }
  `, { input }, token);

  const result = data.createPost;
  // Surface any error types
  if (result?.message) throw new Error(result.message + (result.code ? ` (code: ${result.code})` : ''));
  return result?.post || result;
}

// Schedule a clip post on all given channelIds
async function scheduleClipPosts(token, channelIds, clip, caption, postDate) {
  const results = [];
  const videoUrl = clip.dubbedUrl || clip.url;
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds];

  for (const channelId of ids) {
    try {
      const result = await createPost(token, null, channelId, caption, videoUrl, postDate instanceof Date ? postDate.toISOString() : postDate);
      results.push({ channelId, result, ok: true });
    } catch (e) {
      results.push({ channelId, error: e.message, ok: false });
    }
  }
  return results;
}

// Get pending/scheduled posts for a channel
async function getPendingPosts(token, orgId, channelId) {
  const data = await gqlRequest(`
    query GetPosts($input: PostsInput!) {
      posts(input: $input) {
        edges {
          node {
            id
            text
            status
            scheduledAt
            channel { id name service }
          }
        }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  `, {
    input: {
      organizationId: orgId,
      filter: { channelIds: [channelId], status: ['scheduled'] },
      first: 20,
    }
  }, token);
  return data.posts;
}

module.exports = { getAccount, getChannels, createPost, scheduleClipPosts, getPendingPosts, BUFFER_TOKEN };
