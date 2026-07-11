/**
 * Twitter API 封装层（Cookie 模式）
 *
 * 使用 auth_token + ct0 模拟网页端请求，调用 Twitter 内部 GraphQL API。
 * 无需 Developer Portal 申请，直接复制浏览器 Cookie 即可。
 *
 * 凭据获取方式：浏览器登录 Twitter → F12 → Application → Cookies → x.com
 *   复制 auth_token 和 ct0 两个字段的值即可。
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'https';
import http from 'http';

export interface TwitterCredentials {
  authToken: string;
  ct0: string;
}

// ─── 代理配置 ──────────────────────────────────────────────
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

/**
 * 基于 https 模块的 fetch 替代，走 HTTP 代理。
 * Node.js 内建 fetch (undici) 不接受 http.Agent 作为 dispatcher，
 * 因此用 https.request + HttpsProxyAgent 实现代理请求。
 */
function fetchWithProxy(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: init?.method || 'GET',
      headers: init?.headers as Record<string, string> || {},
      agent: proxyAgent,
      timeout: 30_000,
    };

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const response = {
          status: res.statusCode || 0,
          statusText: res.statusMessage || '',
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          headers: new Headers(res.headers as Record<string, string>),
          text: () => Promise.resolve(body.toString('utf-8')),
          json: () => Promise.resolve(JSON.parse(body.toString('utf-8'))),
          arrayBuffer: () => Promise.resolve(body.buffer),
          bodyUsed: false,
        } as unknown as Response;
        resolve(response);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (init?.body) {
      req.write(init.body);
    }
    req.end();
  });
}

// ─── Twitter 内部 GraphQL queryId（需随版本更新）───────────
// 这些 ID 可从 Twitter 网页源码中的 main.*.js 提取，若失效需更新。
const QUERY_IDS = {
  SearchTimeline: 'Bcw3RzK-PatNAmbnw54hFw',
  TweetDetail: 'jd3V43oDY9cY7obs1YMfbQ',
  CreateTweet: 'R5EPiGHgSqbTYFyozd-gFw',
  DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ',
  UserByScreenName: '2qvSHpkWTMS9i0zJAwDNiA',
} as const;

// Twitter 公开的 guest Bearer Token（网页端内置）
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const BASE = 'https://x.com/i/api/graphql';

// ─── HTTP 辅助 ────────────────────────────────────────────

function headers(creds: TwitterCredentials): Record<string, string> {
  return {
    'Authorization': `Bearer ${BEARER}`,
    'Cookie': `auth_token=${creds.authToken}; ct0=${creds.ct0}`,
    'x-csrf-token': creds.ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en',
    'Content-Type': 'application/json',
    // 模拟浏览器 headers，避免被当作 bot 静默拒绝
    'Origin': 'https://x.com',
    'Referer': 'https://x.com/home',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

async function gqlFetch<T>(
  creds: TwitterCredentials,
  queryId: string,
  operationName: string,
  variables: Record<string, unknown>,
  features?: Record<string, unknown>,
  method: 'GET' | 'POST' = 'GET',
): Promise<T | null> {
  try {
    const url = `${BASE}/${queryId}/${operationName}`;
    const init: RequestInit = {
      method,
      headers: headers(creds),
    };

    let resp: Response;
    if (method === 'POST') {
      init.body = JSON.stringify({ variables, features: features || {}, queryId });
      resp = await fetchWithProxy(url, init);
    } else {
      const getUrl = new URL(url);
      getUrl.searchParams.set('variables', JSON.stringify(variables));
      if (features) getUrl.searchParams.set('features', JSON.stringify(features));
      resp = await fetchWithProxy(getUrl.toString(), init);
    }

    if (resp.status === 429) {
      console.warn(`[twitter-api] 429 rate limited for ${operationName}, waiting 60s...`);
      await new Promise(r => setTimeout(r, 60_000));
      return gqlFetch(creds, queryId, operationName, variables, features, method);
    }

    const raw = await resp.text();
    if (!resp.ok) {
      console.error(`[twitter-api] HTTP ${resp.status} for ${operationName}: ${raw.substring(0, 200)}`);
      return null;
    }

    try {
      const respData = JSON.parse(raw);
      return respData?.data as T | null;
    } catch {
      console.error(`[twitter-api] JSON parse error for ${operationName}: ${raw.substring(0, 200)}`);
      return null;
    }
  } catch (e) {
    console.error(`[twitter-api] gqlFetch ${operationName} error:`, (e as Error).message);
    return null;
  }
}

// ─── 推文相关类型 ──────────────────────────────────────────

export interface TweetResult {
  rest_id: string;
  legacy: {
    full_text: string;
    created_at: string;
    reply_count: number;
    retweet_count: number;
    favorite_count: number;
    retweeted_status_result?: unknown;
    in_reply_to_status_id_str?: string;
    conversation_id_str?: string;
    lang?: string;
  };
  core?: {
    user_results?: {
      result?: UserResult;
    };
  };
}

export interface UserResult {
  rest_id: string;
  core?: {
    screen_name: string;
    name: string;
  };
  legacy?: {
    description?: string;
    followers_count: number;
    friends_count: number;
    verified?: boolean;
  };
}

interface TimelineEntry {
  entryId: string;
  content?: {
    itemContent?: {
      tweet_results?: { result?: TweetResult };
    };
    cursorType?: string;
    value?: string;
  };
}

// ─── SearchTimeline ────────────────────────────────────────

interface SearchTimelineData {
  search_by_raw_query?: {
    search_timeline?: {
      timeline?: {
        instructions?: Array<{
          type: string;
          entries?: TimelineEntry[];
        }>;
      };
    };
  };
}

/** 搜索最近推文（cookie 模式，相当于网页搜索框） */
export async function searchTweets(
  creds: TwitterCredentials,
  keyword: string,
  options: { maxResults?: number; startTime?: Date } = {},
): Promise<{ tweets: TweetResult[]; includes: { users: UserResult[] } }> {
  const variables: Record<string, unknown> = {
    rawQuery: keyword,
    count: Math.min(options.maxResults || 100, 100),
    product: 'Latest',
    querySource: 'typed_query',
  };
  if (options.startTime) {
    variables.startTime = options.startTime.toISOString();
  }

  // SearchTimeline 使用 POST，响应的 data 键名是 search_by_raw_query 而非 operationName
  try {
    const url = `${BASE}/${QUERY_IDS.SearchTimeline}/SearchTimeline`;
    const resp = await fetchWithProxy(url, {
      method: 'POST',
      headers: { ...headers(creds), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variables,
        features: {},
        queryId: QUERY_IDS.SearchTimeline,
      }),
    });
    const json = await resp.json();
    const searchData = json?.data?.search_by_raw_query as SearchTimelineData['search_by_raw_query'] | undefined;

    const tweets: TweetResult[] = [];
    const users: UserResult[] = [];

    const instructions = searchData?.search_timeline?.timeline?.instructions;
    if (instructions) {
      for (const inst of instructions) {
        if (inst.type === 'TimelineAddEntries') {
          for (const entry of inst.entries || []) {
            const tr = entry.content?.itemContent?.tweet_results?.result;
            if (tr && tr.rest_id) {
              tweets.push(tr);
              if (tr.core?.user_results?.result) {
                users.push(tr.core.user_results.result);
              }
            }
          }
        }
      }
    }

    return { tweets, includes: { users } };
  } catch {
    return { tweets: [], includes: { users: [] } };
  }
}

// ─── TweetDetail ───────────────────────────────────────────

interface TweetDetailResponse {
  threaded_conversation_with_injections_v2?: {
    instructions?: Array<{
      type: string;
      entries?: TimelineEntry[];
    }>;
  };
}

const TWEET_DETAIL_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

/** 获取单条推文详情 */
export async function getTweet(
  creds: TwitterCredentials,
  tweetId: string,
): Promise<{ tweet: TweetResult | null; author: UserResult | null }> {
  const data = await gqlFetch<TweetDetailResponse>(
    creds, QUERY_IDS.TweetDetail, 'TweetDetail',
    {
      focalTweetId: tweetId,
      with_rux_injections: false,
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: false,
      withVoice: true,
      withV2Timeline: true,
    },
    TWEET_DETAIL_FEATURES,
  );

  const instructions =
    data?.threaded_conversation_with_injections_v2?.instructions;
  if (!instructions) return { tweet: null, author: null };

  let tweet: TweetResult | null = null;
  let author: UserResult | null = null;

  for (const inst of instructions) {
    for (const entry of inst.entries || []) {
      const tr = entry.content?.itemContent?.tweet_results?.result;
      if (tr && tr.rest_id === tweetId) {
        tweet = tr;
        author = tr.core?.user_results?.result || null;
        break;
      }
    }
    if (tweet) break;
  }

  // Fallback: take first tweet from thread
  if (!tweet) {
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const tr = entry.content?.itemContent?.tweet_results?.result;
        if (tr && tr.rest_id) {
          tweet = tr;
          author = tr.core?.user_results?.result || null;
          break;
        }
      }
      if (tweet) break;
    }
  }

  return { tweet, author };
}

/** 批量获取推文（依次调用 getTweet） */
export async function getTweets(
  creds: TwitterCredentials,
  tweetIds: string[],
): Promise<Map<string, { tweet: TweetResult; author: UserResult | null }>> {
  const result = new Map<string, { tweet: TweetResult; author: UserResult | null }>();
  for (const tid of tweetIds) {
    const { tweet, author } = await getTweet(creds, tid);
    if (tweet) result.set(tid, { tweet, author });
  }
  return result;
}

// ─── CreateTweet（发回复）──────────────────────────────────

interface CreateTweetResponse {
  result?: {
    rest_id?: string;
    errors?: Array<{ message: string }>;
    __typename?: string;
  };
}

/** 发一条回复 */
export async function postReply(
  creds: TwitterCredentials,
  tweetId: string,
  text: string,
): Promise<{ ok: boolean; replyId?: string; err?: string }> {
  const variables = {
    tweet_text: text,
    reply: {
      in_reply_to_tweet_id: tweetId,
      exclude_reply_user_ids: [],
    },
    dark_request: false,
    media: { media_entities: [], possibly_sensitive: false },
    semantic_annotation_ids: [],
    disallowed_reply_options: null,
  };

  try {
    const url = `${BASE}/${QUERY_IDS.CreateTweet}/CreateTweet`;
    const resp = await fetchWithProxy(url, {
      method: 'POST',
      headers: { ...headers(creds), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variables,
        features: { ...TWEET_DETAIL_FEATURES, tweetypie_unmention_optimization_enabled: true },
        queryId: QUERY_IDS.CreateTweet,
      }),
    });
    const raw = await resp.text();
    let json: any;
    try { json = JSON.parse(raw); } catch { return { ok: false, err: `Invalid JSON response: ${raw.substring(0, 200)}` }; }

    // 检查顶层 errors（权限/限流等）
    if (json?.errors?.length > 0) {
      const topErr = json.errors[0];
      return { ok: false, err: topErr?.message || `API error code ${topErr?.code}` };
    }

    // 新版响应结构: data.create_tweet.tweet_results.result.rest_id
    const tweetResult = json?.data?.create_tweet?.tweet_results?.result;
    if (tweetResult?.rest_id) {
      return { ok: true, replyId: tweetResult.rest_id };
    }

    // 兼容旧版: data.create_tweet.result.rest_id
    const legacyResult = json?.data?.create_tweet?.result;
    if (legacyResult?.rest_id) {
      return { ok: true, replyId: legacyResult.rest_id };
    }

    // 检查 result.errors
    const errs = legacyResult?.errors;
    const msg = errs?.[0]?.message || `HTTP ${resp.status}: ${raw.substring(0, 200)}`;
    return { ok: false, err: msg };
  } catch (e: any) {
    return { ok: false, err: e.message || 'Network error' };
  }
}

// ─── DeleteTweet ───────────────────────────────────────────

interface DeleteTweetResponse {
  result?: { rest_id?: string };
}

/** 删除一条推文（清理探测评论用） */
export async function deleteTweet(
  creds: TwitterCredentials,
  tweetId: string,
): Promise<boolean> {
  try {
    const url = `${BASE}/${QUERY_IDS.DeleteTweet}/DeleteTweet`;
    const resp = await fetchWithProxy(url, {
      method: 'POST',
      headers: { ...headers(creds), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variables: { tweet_id: tweetId, dark_request: false },
        queryId: QUERY_IDS.DeleteTweet,
      }),
    });
    const json = await resp.json();
    return !!json?.data?.delete_tweet?.result?.rest_id;
  } catch {
    return false;
  }
}

// ─── UserByScreenName ──────────────────────────────────────

interface UserByScreenNameResponse {
  user?: {
    result?: {
      rest_id?: string;
      core?: {
        screen_name: string;
        name: string;
      };
      legacy?: {
        description?: string;
        followers_count: number;
      };
    };
  };
}

/** 按用户名获取用户信息 */
export async function getUserByUsername(
  creds: TwitterCredentials,
  username: string,
): Promise<UserResult | null> {
  const screenName = username.replace(/^@/, '');
  const resp = await gqlFetch<UserByScreenNameResponse>(
    creds, QUERY_IDS.UserByScreenName, 'UserByScreenName',
    { screen_name: screenName, withSafetyModeUserFields: true },
  );
  const result = resp?.user?.result;
  if (result?.rest_id) {
    return {
      rest_id: result.rest_id,
      core: {
        name: result.core?.name || screenName,
        screen_name: result.core?.screen_name || screenName,
      },
      legacy: {
        description: result.legacy?.description,
        followers_count: result.legacy?.followers_count || 0,
        friends_count: 0,
      },
    };
  }
  return null;
}

// ─── searchReplies ─────────────────────────────────────────
// 复用 TweetDetail 接口获取对话线程

/** 搜索某条推文的回复 */
export async function searchReplies(
  creds: TwitterCredentials,
  tweetId: string,
  options: { maxResults?: number } = {},
): Promise<TweetResult[]> {
  const { tweet } = await getTweet(creds, tweetId);
  if (!tweet) return [];

  // Use search API with conversation_id filter
  const { tweets } = await searchTweets(creds, `conversation_id:${tweetId}`, {
    maxResults: options.maxResults || 100,
  });
  return tweets.filter((t) => t.rest_id !== tweetId);
}
