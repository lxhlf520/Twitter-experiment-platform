/**
 * Twitter API 封装层（Cookie 模式）
 *
 * 使用 auth_token + ct0 模拟网页端请求，调用 Twitter 内部 GraphQL API。
 * 无需 Developer Portal 申请，直接复制浏览器 Cookie 即可。
 *
 * 凭据获取方式：浏览器登录 Twitter → F12 → Application → Cookies → x.com
 *   复制 auth_token 和 ct0 两个字段的值即可。
 */

export interface TwitterCredentials {
  authToken: string;
  ct0: string;
}

// ─── Twitter 内部 GraphQL queryId（需随版本更新）───────────
// 这些 ID 可从 Twitter 网页源码中的 main.*.js 提取，若失效需更新。
const QUERY_IDS = {
  SearchTimeline: 'gkjsKepM6gl_HmFWoWKfgg',
  TweetDetail: 'nVK5TAzE5Pw2xwXrk3eGIA',
  CreateTweet: 'tTsjMKyhajZvK4qRmpArFg',
  DeleteTweet: 'VaenaVgh5q5ih7kvyVjgtg',
  UserByScreenName: 'G3KGOASz96M-Qu0nwmGJNQ',
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
  const url = new URL(`${BASE}/${queryId}/${operationName}`);
  url.searchParams.set('variables', JSON.stringify(variables));
  if (features) url.searchParams.set('features', JSON.stringify(features));

  try {
    const init: RequestInit = {
      method,
      headers: headers(creds),
    };
    // POST for CreateTweet, GET for queries
    if (method === 'POST') {
      init.body = JSON.stringify({
        variables,
        features: features || {},
        queryId,
      });
      // For POST, use base URL without query params
      const postUrl = `${BASE}/${queryId}/${operationName}`;
      const resp = await fetch(postUrl, init);
      const data = await resp.json();
      return (data?.data?.[operationName] ?? null) as T | null;
    }
    const resp = await fetch(url.toString(), init);
    const data = await resp.json();
    return (data?.data?.[operationName] ?? null) as T | null;
  } catch {
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
  };
  core?: {
    user_results?: {
      result?: UserResult;
    };
  };
}

export interface UserResult {
  rest_id: string;
  legacy: {
    name: string;
    screen_name: string;
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

interface SearchTimelineResponse {
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

  const data = await gqlFetch<SearchTimelineResponse>(
    creds, QUERY_IDS.SearchTimeline, 'SearchTimeline', variables,
  );

  const tweets: TweetResult[] = [];
  const users: UserResult[] = [];

  const instructions = data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
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
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...headers(creds), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variables,
        features: { ...TWEET_DETAIL_FEATURES, tweetypie_unmention_optimization_enabled: true },
        queryId: QUERY_IDS.CreateTweet,
      }),
    });
    const json = await resp.json();
    const data = json?.data?.create_tweet as CreateTweetResponse | undefined;

    if (data?.result?.rest_id) {
      return { ok: true, replyId: data.result.rest_id };
    }
    const errs = data?.result?.errors;
    const msg = errs?.[0]?.message || `HTTP ${resp.status}`;
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
    const resp = await fetch(url, {
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
  result?: {
    rest_id?: string;
    legacy?: {
      name: string;
      screen_name: string;
      description?: string;
      followers_count: number;
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
  if (resp?.result?.rest_id) {
    return {
      rest_id: resp.result.rest_id,
      legacy: {
        name: resp.result.legacy?.name || screenName,
        screen_name: resp.result.legacy?.screen_name || screenName,
        description: resp.result.legacy?.description,
        followers_count: resp.result.legacy?.followers_count || 0,
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
