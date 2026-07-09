/**
 * Twitter API 封装层
 * 基于 twitter-api-v2，使用 OAuth 1.0a 用户上下文
 */

import { TwitterApi, TweetV2, ApiResponseError } from 'twitter-api-v2';

export interface TwitterCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** Create a TwitterApi client from account credentials */
export function createClient(creds: TwitterCredentials): TwitterApi {
  return new TwitterApi({
    appKey: creds.apiKey,
    appSecret: creds.apiSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessTokenSecret,
  });
}

/** Search recent tweets by keyword (last 7 days for free tier, enough for 12h window) */
export async function searchTweets(
  creds: TwitterCredentials,
  keyword: string,
  options: { maxResults?: number; startTime?: Date } = {},
): Promise<{ tweets: TweetV2[]; includes: any }> {
  const client = createClient(creds);
  try {
    const result = await client.v2.search(keyword, {
      'tweet.fields': ['created_at', 'public_metrics', 'referenced_tweets', 'author_id', 'text'],
      'user.fields': ['name', 'username', 'description', 'public_metrics', 'verified'],
      'expansions': ['author_id', 'referenced_tweets.id'],
      max_results: options.maxResults || 100,
      ...(options.startTime ? { start_time: options.startTime.toISOString() } : {}),
    });
    return {
      tweets: result.tweets || [],
      includes: result.includes || {},
    };
  } catch (e) {
    if (e instanceof ApiResponseError && e.code === 429) {
      // Rate limited - wait and retry once
      await new Promise(r => setTimeout(r, 15 * 60 * 1000));
      throw new Error('Twitter API rate limited (429)');
    }
    throw e;
  }
}

/** Get a single tweet with metrics */
export async function getTweet(
  creds: TwitterCredentials,
  tweetId: string,
): Promise<{ tweet: TweetV2 | null; author: any | null }> {
  const client = createClient(creds);
  try {
    const result = await client.v2.singleTweet(tweetId, {
      'tweet.fields': ['created_at', 'public_metrics', 'referenced_tweets', 'author_id', 'text'],
      'user.fields': ['name', 'username', 'description', 'public_metrics', 'verified'],
      'expansions': ['author_id'],
    });
    const tweet = result.data || null;
    const author = tweet && result.includes?.users?.find(u => u.id === tweet.author_id) || null;
    return { tweet, author };
  } catch {
    return { tweet: null, author: null };
  }
}

/** Get multiple tweets with metrics (batch) */
export async function getTweets(
  creds: TwitterCredentials,
  tweetIds: string[],
): Promise<Map<string, { tweet: TweetV2; author: any }>> {
  const client = createClient(creds);
  const result = new Map<string, { tweet: TweetV2; author: any }>();
  try {
    const resp = await client.v2.tweets(tweetIds, {
      'tweet.fields': ['created_at', 'public_metrics', 'referenced_tweets', 'author_id', 'text'],
      'user.fields': ['name', 'username', 'description', 'public_metrics', 'verified'],
      'expansions': ['author_id'],
    });
    for (const tweet of resp.data || []) {
      const author = resp.includes?.users?.find(u => u.id === tweet.author_id) || null;
      result.set(tweet.id, { tweet, author });
    }
  } catch {
    // Return partial results
  }
  return result;
}

/** Post a reply to a tweet */
export async function postReply(
  creds: TwitterCredentials,
  tweetId: string,
  text: string,
): Promise<{ ok: boolean; replyId?: string; err?: string }> {
  const client = createClient(creds);
  try {
    const result = await client.v2.reply(text, tweetId);
    return { ok: true, replyId: result.data?.id };
  } catch (e: any) {
    const msg = e.data?.detail || e.message || 'Unknown error';
    return { ok: false, err: msg };
  }
}

/** Get user info by username */
export async function getUserByUsername(
  creds: TwitterCredentials,
  username: string,
): Promise<any | null> {
  const client = createClient(creds);
  try {
    const result = await client.v2.userByUsername(username, {
      'user.fields': ['name', 'username', 'description', 'public_metrics', 'verified'],
    });
    return result.data || null;
  } catch {
    return null;
  }
}

/** Delete a tweet (for cleaning up probe comments) */
export async function deleteTweet(
  creds: TwitterCredentials,
  tweetId: string,
): Promise<boolean> {
  const client = createClient(creds);
  try {
    await client.v2.deleteTweet(tweetId);
    return true;
  } catch {
    return false;
  }
}

/** Search replies to a specific tweet (conversation search) */
export async function searchReplies(
  creds: TwitterCredentials,
  tweetId: string,
  options: { maxResults?: number } = {},
): Promise<TweetV2[]> {
  const client = createClient(creds);
  try {
    const result = await client.v2.search(`conversation_id:${tweetId}`, {
      'tweet.fields': ['created_at', 'public_metrics', 'author_id', 'text'],
      'user.fields': ['name', 'username', 'description'],
      'expansions': ['author_id'],
      max_results: options.maxResults || 100,
    });
    return result.tweets || [];
  } catch {
    return [];
  }
}
