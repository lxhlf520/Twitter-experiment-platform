/**
 * 正式实验 - 分批增量建池 + 选帖建实验（Twitter 适配版，纽约时间）
 * ============================================================================
 * 策略（纽约时间 16/18/20 每 2 小时一批）：
 *   runCollectBatch()   单批采集 CANDIDATE_BATCH 条候选 → 筛选 → 按作者去重
 *                       upsert 到 candidate_pool（跨批累计）；合格 ≥ TARGET_QUALIFIED
 *                       则标记 pool_full，后续批次跳过采集。红线约束绝不放宽。
 *   finalizeExperiment() 从 candidate_pool 选 EXPERIMENT_POSTS 实验帖（三等分+模板）
 *                       + 其余作备选(is_spare)，写 posts / intervention_logs，
 *                       实验 status → ready。池不足 90 则缩减为最大 3 倍数并告警。
 *
 * 直跑调试：
 *   npx tsx src/jobs/collector.ts batch      # 跑一批采集
 *   npx tsx src/jobs/collector.ts finalize   # 选帖建实验
 */

import { insert, query, maybeOne, updateOne, upsert, count } from '../lib/db';
import { randomizeAndGroup, assignTemplates } from '../lib/experiment-engine';
import { searchTweets, getTweet } from '../lib/twitter-api';
import type { TweetResult, UserResult } from '../lib/twitter-api';
import {
  ScreeningPost,
  TwitterAccount,
  CANDIDATE_BATCH,
  MAX_BATCHES,
  TARGET_QUALIFIED,
  EXPERIMENT_POSTS,
  MAX_PAGES_PER_KEYWORD,
  SEARCH_KEYWORDS,
  EXCLUDE_KW,
  sleep,
  ts,
  now,
  getActiveAccounts,
  getCredentials,
} from './shared';

const POOL = 'candidate_pool';

/** 找/建当天处于采集期的实验；若当天已 finalize（非 collecting）返回 null 表示无需采集 */
async function getOrCreateCollectingExp(): Promise<{ id: string; pool_full?: boolean; batch_count?: number; seen_mids?: string[] } | null> {
  const today = new Date().toISOString().split('T')[0];
  const existing = await maybeOne<{ id: string; status: string; pool_full?: boolean; batch_count?: number; seen_mids?: string[] }>(
    'experiment_runs',
    { experiment_date: today },
  );
  if (existing) {
    if (existing.status !== 'collecting') {
      console.log(`  当天实验已处于 ${existing.status} 状态，跳过采集`);
      return null;
    }
    return existing;
  }
  const created = await insert<{ id: string }>('experiment_runs', {
    user_id: 'admin',
    date: today,
    experiment_date: today,
    status: 'collecting',
    batch_count: 0,
    pool_full: false,
    seen_mids: [],
    completed_points: [],
    created_at: now(),
  });
  return created ? { id: String(created.id), batch_count: 0, seen_mids: [] } : null;
}

/** Convert Twitter GraphQL API result (TweetResult) to ScreeningPost */
function extractScreeningPost(tweet: TweetResult | null, author: UserResult | null): ScreeningPost | null {
  if (!tweet) return null;
  const content = tweet.legacy?.full_text || '';
  const followers = author?.legacy?.followers_count || 0;
  const cc = tweet.legacy?.reply_count || 0;
  const rp = tweet.legacy?.retweet_count || 0;
  const lk = tweet.legacy?.favorite_count || 0;
  const postTime = new Date(tweet.legacy?.created_at || '').getTime();
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000; // TEST: 放宽到 7 天
  const isRetweet = !!tweet.legacy?.retweeted_status_result;
  const wordCount = (content || '').split(/\s+/).filter((w: string) => w.length > 0).length;
  const authorUid = author?.rest_id || tweet.core?.user_results?.result?.rest_id || '';
  const authorName = author?.core?.name || author?.core?.screen_name || '';

  // Hard filtering (TEST: relaxed)
  if (!postTime || postTime < cutoff) return null;
  if (isRetweet) return null;
  if (wordCount < 3) return null;
  if (cc < 10 || cc > 500) return null;
  if (followers >= 5_000_000) return null;
  if (EXCLUDE_KW.some((kw) => content.toLowerCase().includes(kw.toLowerCase()))) return null;

  // 只采集英文推文
  const lang = tweet.legacy?.lang;
  if (lang && lang !== 'en') return null;

  return {
    postId: tweet.rest_id,
    postUrl: `https://twitter.com/i/status/${tweet.rest_id}`,
    content,
    authorUid,
    authorName,
    followers,
    commentsCount: cc,
    repostsCount: rp,
    likesCount: lk,
    publishedAt: tweet.legacy?.created_at || '',
  };
}

/** 单批采集：用 Twitter API 搜索 → 筛选 → 按作者去重 upsert 到候选池 */
export async function runCollectBatch(): Promise<{ experimentId: string; qualified: number; poolFull: boolean } | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[采集批次] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  if (accounts.length < 2) {
    console.log(`❌ 可用账号不足（${accounts.length}），至少需要 2 个`);
    return null;
  }
  console.log(`可用账号 (${accounts.length}): ${accounts.map((a) => a.nickname).join(', ')}`);

  const exp = await getOrCreateCollectingExp();
  if (!exp) return null;
  const experimentId = exp.id;

  let qualified = await count(POOL, { experiment_id: experimentId });
  if (exp.pool_full || qualified >= TARGET_QUALIFIED) {
    console.log(`  候选池已达标（${qualified}/${TARGET_QUALIFIED}），跳过本批采集`);
    await updateOne('experiment_runs', { id: experimentId }, { pool_full: true });
    return { experimentId, qualified, poolFull: true };
  }
  if ((exp.batch_count || 0) >= MAX_BATCHES) {
    console.log(`  已达最大批次 ${MAX_BATCHES}，跳过采集`);
    return { experimentId, qualified, poolFull: false };
  }
  console.log(`  当前池: ${qualified}/${TARGET_QUALIFIED}  批次: ${(exp.batch_count || 0) + 1}/${MAX_BATCHES}`);

  // ── 用 Twitter API 搜索，直接用返回结果筛选（不再逐条调 getTweet）──
  const seen = new Set<string>(exp.seen_mids || []);
  const startTime = new Date(Date.now() - 7 * 24 * 3600 * 1000); // TEST: 7 天
  let added = 0;

  outer: for (const kw of SEARCH_KEYWORDS) {
    for (let ai = 0; ai < accounts.length; ai++) {
      try {
        const result = await searchTweets(getCredentials(accounts[ai]), kw, {
          maxResults: 100,
          startTime,
        });
        for (const t of result.tweets) {
          if (seen.has(t.rest_id)) continue;
          seen.add(t.rest_id);

          // 从搜索结果提取 author（user 信息已包含在 tweet.core.user_results 中）
          const author = t.core?.user_results?.result || null;
          const sp = extractScreeningPost(t, author);
          if (sp) {
            const before = await count(POOL, { experiment_id: experimentId, author_uid: sp.authorUid });
            await upsert(POOL, { experiment_id: experimentId, author_uid: sp.authorUid }, {
              experiment_id: experimentId,
              post_id: sp.postId,
              post_url: sp.postUrl,
              content: sp.content,
              author_uid: sp.authorUid,
              author_name: sp.authorName,
              followers: sp.followers,
              comments_count: sp.commentsCount,
              reposts_count: sp.repostsCount,
              likes_count: sp.likesCount,
              published_at: sp.publishedAt,
            });
            if (before === 0) added++;
            qualified = await count(POOL, { experiment_id: experimentId });
            if (qualified >= TARGET_QUALIFIED) {
              console.log(`  合格已达标: ${qualified}`);
              break outer;
            }
          }
        }
      } catch {
        /* single failure skip */
      }
      await sleep(1000 + Math.random() * 1500);
    }
  }

  qualified = await count(POOL, { experiment_id: experimentId });
  const poolFull = qualified >= TARGET_QUALIFIED;
  await updateOne('experiment_runs', { id: experimentId }, {
    batch_count: (exp.batch_count || 0) + 1,
    pool_full: poolFull,
    seen_mids: [...seen],
  });

  console.log(`\n✅ 本批完成: 新增合格 ${added} 篇，池累计 ${qualified}/${TARGET_QUALIFIED}${poolFull ? '（已达标）' : ''}`);
  return { experimentId, qualified, poolFull };
}

/** 选帖建实验：从候选池选实验帖 + 备选，写 posts / intervention_logs，status → ready */
export async function finalizeExperiment(): Promise<{ experimentId: string } | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[选帖建实验] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const today = new Date().toISOString().split('T')[0];
  const exp = await maybeOne<{ id: string; status: string }>('experiment_runs', { experiment_date: today });
  if (!exp) {
    console.log('❌ 未找到当天实验');
    return null;
  }
  const experimentId = String(exp.id);
  if (exp.status !== 'collecting') {
    console.log(`  当天实验已处于 ${exp.status} 状态，无需重复 finalize`);
    return { experimentId };
  }

  const { rows: poolRows } = await query<{
    id: string; post_id: string; post_url: string; content: string;
    author_uid: string; author_name: string; followers: number;
    comments_count: number; reposts_count: number; likes_count: number; published_at: string;
  }>(POOL, { experiment_id: experimentId });
  const pool: ScreeningPost[] = poolRows.map((r) => ({
    postId: r.post_id,
    postUrl: r.post_url,
    content: r.content,
    authorUid: r.author_uid,
    authorName: r.author_name,
    followers: r.followers,
    commentsCount: r.comments_count,
    repostsCount: r.reposts_count,
    likesCount: r.likes_count,
    publishedAt: r.published_at,
  }));
  console.log(`候选池合格帖: ${pool.length} 篇`);

  let expCount = EXPERIMENT_POSTS;
  if (pool.length < EXPERIMENT_POSTS) {
    expCount = Math.floor(pool.length / 3) * 3;
    console.log(`⚠️ 告警：候选池不足 ${EXPERIMENT_POSTS} 篇，缩减实验帖为 ${expCount}（三等分）`);
    if (expCount < 3) {
      await updateOne('experiment_runs', { id: experimentId }, { status: 'failed', fail_reason: `候选池仅 ${pool.length} 篇` });
      console.log(`❌ 候选池过少（${pool.length}），实验标记 failed`);
      return null;
    }
  }

  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const total = Math.min(shuffled.length, TARGET_QUALIFIED);
  const finalPosts = shuffled.slice(0, total);
  const experimentPosts = finalPosts.slice(0, expCount);
  const sparePosts = finalPosts.slice(expCount);
  console.log(`实验帖 ${experimentPosts.length} 篇 + 备选 ${sparePosts.length} 篇`);

  const { grouped, config } = randomizeAndGroup(experimentPosts, expCount);
  const withTemplates = await assignTemplates(grouped);

  for (const item of withTemplates) {
    const p = (item as any).post as ScreeningPost;
    const post = await insert<{ id: string }>('posts', {
      user_id: 'admin',
      experiment_id: experimentId,
      post_id: p.postId,
      post_url: p.postUrl,
      content: p.content,
      author_uid: p.authorUid,
      author_name: p.authorName,
      followers: p.followers,
      comments_count: p.commentsCount,
      reposts_count: p.repostsCount,
      likes_count: p.likesCount,
      post_group: item.group,
      is_spare: false,
      published_at: p.publishedAt,
    });
    if (post && item.group !== 'control') {
      await insert('intervention_logs', {
        experiment_id: experimentId,
        post_id: String(post.id),
        post_url: p.postUrl,
        post_group: item.group,
        comment_template: (item as any).templateId ? String((item as any).templateId) : null,
        comment_content: item.commentContent,
        status: 'pending',
      });
    }
  }

  for (const p of sparePosts) {
    await insert('posts', {
      user_id: 'admin',
      experiment_id: experimentId,
      post_id: p.postId,
      post_url: p.postUrl,
      content: p.content,
      author_uid: p.authorUid,
      author_name: p.authorName,
      followers: p.followers,
      comments_count: p.commentsCount,
      reposts_count: p.repostsCount,
      likes_count: p.likesCount,
      post_group: null,
      is_spare: true,
      published_at: p.publishedAt,
    });
  }

  await updateOne('experiment_runs', { id: experimentId }, {
    status: 'ready',
    total_posts: finalPosts.length,
    control_count: config.controlCount,
    low_count: config.lowCount,
    high_count: config.highCount,
  });

  console.log(`\n✅ 实验就绪`);
  console.log(`   experimentId: ${experimentId}`);
  console.log(`   control: ${config.controlCount} | low: ${config.lowCount} | high: ${config.highCount}`);
  console.log(`   待发评论: ${withTemplates.filter((i) => i.group !== 'control').length} 条`);
  console.log(`   备选池: ${sparePosts.length} 篇`);
  return { experimentId };
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/collector.ts')) {
  const mode = process.argv[2] || 'batch';
  const run = mode === 'finalize' ? finalizeExperiment : runCollectBatch;
  run()
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('采集异常:', e);
      process.exit(1);
    });
}
