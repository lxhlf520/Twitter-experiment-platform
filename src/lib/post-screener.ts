import type { TweetResult, UserResult } from './twitter-api';
import { ScreeningPost } from '../jobs/shared';

/**
 * Post 筛选规则引擎（Twitter 适配版）
 * 根据实验规则文档 V2.0 的硬性约束进行筛选
 */

export interface ScreeningCriteria {
  /** 发布时间上限（小时），默认12 */
  maxHoursAgo?: number;
  /** 最少英文单词数，默认8 */
  minWords?: number;
  /** 评论数下限，默认10 */
  minComments?: number;
  /** 评论数上限，默认500 */
  maxComments?: number;
  /** 最大粉丝数，默认500000 */
  maxFollowers?: number;
  /** 排除的关键词（话题、营销等） */
  excludeKeywords?: string[];
}

const DEFAULT_EXCLUDE_KEYWORDS = [
  // Sensitive/political
  'giveaway', 'contest', 'win', 'free', 'discount', 'promo', 'sale', 'deal',
  // Spam/ads
  'buy now', 'click here', 'subscribe', 'follow me', 'dm me', 'dm for',
  // Financial/scam
  'crypto', 'bitcoin', 'nft', 'investment', 'earn money', 'make money',
  'get rich', 'forex', 'trading signal',
  // Medical/legal
  'medical advice', 'legal advice',
];

const AI_IDENTITY_KEYWORDS = ['ai', 'bot', 'chatgpt', 'gpt', 'artificial intelligence', 'ai assistant'];

/**
 * 检查是否为原创帖子（非转发）
 */
function isOriginal(tweet: TweetResult): boolean {
  return !tweet.legacy?.retweeted_status_result;
}

/**
 * 检查帖子是否公开可见
 */
function isPublic(_tweet: TweetResult): boolean {
  return true;
}

/**
 * 检查用户是否为普通个人账号（排除官方/机构账号）
 */
function isNormalUser(_tweet: TweetResult, author: UserResult | null): boolean {
  if (author?.legacy?.verified && (author?.legacy?.followers_count || 0) < 100) {
    return false;
  }
  return true;
}

function containsExcludeKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * AI回复三层过滤 - 第二层：排除简介含AI身份线索的用户
 */
function filterLayer2_aiProfile(items: { tweet: TweetResult; author: UserResult | null; sp: ScreeningPost }[]): { tweet: TweetResult; author: UserResult | null; sp: ScreeningPost }[] {
  return items.filter(({ author }) => {
    const userName = (author?.legacy?.name || '').toLowerCase();
    const userDesc = (author?.legacy?.description || '').toLowerCase();
    return !AI_IDENTITY_KEYWORDS.some(
      (kw) => userName.includes(kw.toLowerCase()) || userDesc.includes(kw.toLowerCase()),
    );
  });
}

/**
 * 用户去重：确保POST池中的用户不重复
 */
function deduplicateUsers(items: { tweet: TweetResult; author: UserResult | null; sp: ScreeningPost }[]): { tweet: TweetResult; author: UserResult | null; sp: ScreeningPost }[] {
  const seenUids = new Set<string>();
  return items.filter(({ author }) => {
    const uid = author?.rest_id || '';
    if (seenUids.has(uid)) return false;
    seenUids.add(uid);
    return true;
  });
}

/**
 * 从 tweet object 提取 ScreeningPost
 */
function extractScreeningPost(tweet: TweetResult, author: UserResult | null): ScreeningPost {
  return {
    postId: tweet.rest_id,
    postUrl: `https://twitter.com/i/status/${tweet.rest_id}`,
    content: tweet.legacy?.full_text || '',
    authorUid: author?.rest_id || tweet.core?.user_results?.result?.rest_id || '',
    authorName: author?.legacy?.name || author?.legacy?.screen_name || '',
    followers: author?.legacy?.followers_count || 0,
    commentsCount: tweet.legacy?.reply_count || 0,
    repostsCount: tweet.legacy?.retweet_count || 0,
    likesCount: tweet.legacy?.favorite_count || 0,
    publishedAt: tweet.legacy?.created_at || '',
  };
}

/**
 * 主筛选函数：从搜索结果中筛选符合条件的Post
 */
export async function screenTweets(
  tweets: TweetResult[],
  authors: Map<string, UserResult>,
  criteria: ScreeningCriteria = {},
): Promise<{ passed: ScreeningPost[]; rejected: ScreeningPost[] }> {
  const {
    maxHoursAgo = 12,
    minWords = 8,
    minComments = 10,
    maxComments = 500,
    maxFollowers = 500_000,
    excludeKeywords = DEFAULT_EXCLUDE_KEYWORDS,
  } = criteria;

  const passed: ScreeningPost[] = [];
  const rejected: ScreeningPost[] = [];

  const cutoffTime = Date.now() - maxHoursAgo * 3600 * 1000;

  let enriched: { tweet: TweetResult; author: UserResult | null; sp: ScreeningPost }[] = [];

  for (const tweet of tweets) {
    const authorId = tweet.core?.user_results?.result?.rest_id || '';
    const author = authors.get(authorId) || null;
    const sp = extractScreeningPost(tweet, author);
    const postTime = new Date(tweet.legacy?.created_at || '').getTime();

    // Time check
    if (!postTime || postTime < cutoffTime) {
      rejected.push({ ...sp, failReason: 'Over 12 hours old' });
      continue;
    }

    // Public check
    if (!isPublic(tweet)) {
      rejected.push({ ...sp, failReason: 'Not public' });
      continue;
    }

    // Original check
    if (!isOriginal(tweet)) {
      rejected.push({ ...sp, failReason: 'Retweet' });
      continue;
    }

    // Account type check
    if (!isNormalUser(tweet, author)) {
      rejected.push({ ...sp, failReason: 'Suspicious verified account' });
      continue;
    }

    // Word count check (English words)
    const wordCount = (tweet.legacy?.full_text || '').split(/\s+/).filter((w: string) => w.length > 0).length;
    if (wordCount < minWords) {
      rejected.push({ ...sp, failReason: `Fewer than ${minWords} words` });
      continue;
    }

    // Comments count range check
    const cc = tweet.legacy?.reply_count || 0;
    if (cc < minComments || cc > maxComments) {
      rejected.push({
        ...sp,
        failReason: `Comments ${cc} not in ${minComments}-${maxComments} range`,
      });
      continue;
    }

    // Followers check
    const followers = author?.legacy?.followers_count || 0;
    if (followers >= maxFollowers) {
      rejected.push({ ...sp, failReason: `Followers ${followers} exceeds ${maxFollowers}` });
      continue;
    }

    // Exclude keywords check
    if (containsExcludeKeywords(tweet.legacy?.full_text || '', excludeKeywords)) {
      rejected.push({ ...sp, failReason: 'Contains excluded keywords' });
      continue;
    }

    enriched.push({ tweet, author, sp });
  }

  // User dedup
  enriched = deduplicateUsers(enriched);

  // AI profile filter
  enriched = filterLayer2_aiProfile(enriched);

  const finalPassed = enriched.map(e => e.sp);
  const filteredIds = new Set(finalPassed.map(p => p.postId));
  const aiRejected = passed.filter(p => !filteredIds.has(p.postId));

  return {
    passed: finalPassed,
    rejected: [...rejected, ...aiRejected.map((p) => ({ ...p, failReason: 'AI profile filter not passed' }))],
  };
}
