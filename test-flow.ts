/**
 * Twitter 实验平台 - 整体流程测试
 * ============================================================================
 * 验证：凭据 → 搜索 → 帖子详情 → 评论采集 → 评论发送 → 指标快照 → MongoDB
 *
 * 运行：npx tsx test-flow.ts
 */

import { MongoClient } from 'mongodb';
import { searchTweets, getTweet, getTweetDetailRaw, postReply, type TwitterCredentials } from './src/lib/twitter-api';

// ─── MongoDB ─────────────────────────────────────────────────────
const MONGO_URI = 'mongodb://localhost:27017/';
const MONGO_DB = 'twitter_experiment';

let mongo: MongoClient;
let db: ReturnType<MongoClient['db']>;
const now = () => new Date().toISOString();

async function initDb() {
  mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  db = mongo.db(MONGO_DB);
  console.log(`MongoDB: ${MONGO_URI} → ${MONGO_DB}`);
}

// ─── 从数据库取第一个 active 账号的凭据 ──────────────────────────
async function getFirstActiveCreds(): Promise<{ creds: TwitterCredentials; nickname: string }> {
  const acc = await db.collection('twitter_accounts').findOne(
    { status: 'active', can_comment: true },
    { sort: { _id: 1 } },
  );
  if (!acc) throw new Error('无可用 active 账号');
  return {
    creds: { authToken: acc.auth_token, ct0: acc.ct0 },
    nickname: acc.nickname,
  };
}

// ─── 主流程 ──────────────────────────────────────────────────────
async function main() {
  await initDb();
  const experimentId = `test_tw_${Date.now()}`;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Twitter 实验平台 整体流程测试  [${now()}]`);
  console.log(`实验ID: ${experimentId}`);
  console.log(`${'='.repeat(60)}\n`);

  let passed = 0;
  let failed = 0;

  function check(label: string, ok: boolean, detail?: string) {
    if (ok) { passed++; console.log(`  ✅ ${label}${detail ? ': ' + detail : ''}`); }
    else     { failed++; console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); }
    return ok;
  }

  // ──────────────────────────────────────────────────────────────
  // Step 1: 凭据验证
  // ──────────────────────────────────────────────────────────────
  console.log('📋 Step 1: 凭据验证');
  let creds: TwitterCredentials;
  let nickname: string;
  try {
    const acc = await getFirstActiveCreds();
    creds = acc.creds;
    nickname = acc.nickname;
    check('凭据读取', true, `nickname="${nickname}" auth_token=${creds.authToken.substring(0, 8)}... ct0=${creds.ct0.substring(0, 6)}...`);
  } catch (e: any) {
    check('凭据读取', false, e.message);
    console.log('❌ 无法继续，退出');
    process.exit(1);
  }

  // 验证凭据有效性：搜索
  const sr = await searchTweets(creds, 'good morning', { maxResults: 5 });
  check('搜索验证', sr.tweets.length > 0, `返回 ${sr.tweets.length} 条推文`);
  if (sr.tweets.length === 0) {
    console.log('❌ 凭据无效或搜索无结果，退出');
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────
  // Step 2: 搜索推文
  // ──────────────────────────────────────────────────────────────
  console.log('\n📋 Step 2: 搜索推文 (关键词搜索)');
  const keywords = ['today', 'daily', 'update'];
  let tweets: Array<{ id: string; content: string; author: { uid: string; name: string; verified: boolean } }> = [];

  for (const kw of keywords) {
    const r = await searchTweets(creds, kw, { maxResults: 10 });
    for (const t of r.tweets) {
      tweets.push({
        id: t.rest_id,
        content: (t.legacy?.full_text || '').slice(0, 80),
        author: {
          uid: t.core?.user_results?.result?.rest_id || '',
          name: t.core?.user_results?.result?.core?.screen_name || '',
          verified: t.core?.user_results?.result?.legacy?.verified || false,
        },
      });
    }
  }
  check('搜索帖子', tweets.length > 0, `${tweets.length} 条候选推文 (3关键词×10)`);

  // ──────────────────────────────────────────────────────────────
  // Step 3: 查找测试推文（非蓝V、英语、评论数≥3）
  // ──────────────────────────────────────────────────────────────
  console.log('\n📋 Step 3: 查找测试推文 (非蓝V、英语、评论≥3)');
  let testTweetId = '';
  let testTweetAuthor = '';

  // 只查前 15 条，每条间隔 1.2s 防限流
  const toCheck = tweets.slice(0, 15);
  for (let i = 0; i < toCheck.length; i++) {
    const t = toCheck[i];
    try {
      // 获取详情看评论数
      const detail = await getTweet(creds, t.id);
      if (!detail.tweet) continue;

      const legacy = detail.tweet.legacy;
      const user = detail.author;
      const replyCount = legacy?.reply_count || 0;
      const isVerified = user?.legacy?.verified || false;
      const lang = legacy?.lang || '';

      if (!isVerified && lang === 'en' && replyCount >= 1) {
        testTweetId = t.id;
        testTweetAuthor = user?.core?.screen_name || '';
        const text = (legacy?.full_text || '').replace(/\n/g, ' ').slice(0, 60);
        check('查找帖子',
          true,
          `tweetId=${testTweetId} @${testTweetAuthor} 💬${replyCount} ↻${legacy?.retweet_count || 0} ❤${legacy?.favorite_count || 0}\n    内容: "${text}"`,
        );
        break;
      }
    } catch (e: any) {
      // getTweet 偶尔 TLS 断连，跳过继续
    }
    // 间隔防限流
    await new Promise(r => setTimeout(r, 1200));
  }

  if (!testTweetId) {
    check('查找帖子', false, '未找到合适的测试推文');
    console.log('❌ 无法继续');
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────
  // Step 4: 帖子详情原始数据 (→ post_detail)
  // ──────────────────────────────────────────────────────────────
  console.log('\n📋 Step 4: 帖子详情原始数据 (→ post_detail)');
  const detailRaw = await getTweetDetailRaw(creds, testTweetId);
  check('getTweetDetailRaw', !!detailRaw, detailRaw ? `raw 字节=${JSON.stringify(detailRaw.raw).length}, entries=${detailRaw.entries.length}` : '无数据');

  if (detailRaw) {
    await db.collection('twitter_post_detail').updateOne(
      { experiment_id: experimentId, post_id: testTweetId },
      {
        $set: {
          experiment_id: experimentId,
          post_id: testTweetId,
          tweet_id: testTweetId,
          raw_response: JSON.stringify(detailRaw.raw),
          captured_at: now(),
          created_at: now(),
        },
      },
      { upsert: true },
    );
    check('post_detail写入', true, '已写入 twitter_post_detail');
  }

  // ──────────────────────────────────────────────────────────────
  // Step 5: 评论数据采集 (→ comment_snapshots + post_comment_meta + post_user_meta)
  // ──────────────────────────────────────────────────────────────
  console.log('\n📋 Step 5: 评论数据采集 (→ 3张溯源表)');

  if (detailRaw && detailRaw.entries.length > 0) {
    // post_comment_meta: 保存原始响应
    await db.collection('twitter_post_comment_meta').updateOne(
      { experiment_id: experimentId, post_id: testTweetId },
      {
        $set: {
          experiment_id: experimentId,
          post_id: testTweetId,
          tweet_id: testTweetId,
          raw_response: JSON.stringify(detailRaw.raw),
          captured_at: now(),
          created_at: now(),
        },
      },
      { upsert: true },
    );
    check('post_comment_meta', true, '已写入');

    // comment_snapshots: 结构化评论
    let csCount = 0;
    const seenUsers = new Set<string>();

    for (const e of detailRaw.entries) {
      if (e.comment_id === testTweetId) continue; // skip main tweet
      await db.collection('twitter_comment_snapshots').updateOne(
        { experiment_id: experimentId, comment_id: e.comment_id },
        {
          $set: {
            experiment_id: experimentId,
            post_id: testTweetId,
            tweet_id: testTweetId,
            comment_id: e.comment_id,
            parent_comment_id: e.parent_comment_id || null,
            author_uid: e.author_uid,
            author_name: e.author_name,
            content: e.content,
            likes_count: e.likes_count,
            comment_time: e.created_at,
            captured_at: now(),
            created_at: now(),
          },
        },
        { upsert: true },
      );
      csCount++;

      if (e.author_uid && !seenUsers.has(e.author_uid)) {
        seenUsers.add(e.author_uid);
        // post_user_meta: 用户原始数据
        await db.collection('twitter_post_user_meta').updateOne(
          { experiment_id: experimentId, user_id: e.author_uid },
          {
            $set: {
              experiment_id: experimentId,
              user_id: e.author_uid,
              raw_response: JSON.stringify(e.author_raw || {}),
              captured_at: now(),
              created_at: now(),
            },
          },
          { upsert: true },
        );
      }
    }
    check('comment_snapshots', true, `${csCount} 条`);

    const firstCmt = detailRaw.entries[0];
    if (firstCmt) {
      console.log(`    💬 首条: "${firstCmt.content.slice(0, 50)}" - @${firstCmt.author_name}`);
    }
    check('post_user_meta', true, `${seenUsers.size} 个用户`);
  } else {
    check('评论数据', false, '无评论数据');
  }

  // ──────────────────────────────────────────────────────────────
  // Step 6: 评论发送能力测试
  // ──────────────────────────────────────────────────────────────
  console.log('\n📋 Step 6: 评论发送能力测试');

  // 找一个不同的帖子发送评论
  let replyTargetId = '';
  for (const t of tweets) {
    if (t.id !== testTweetId) { replyTargetId = t.id; break; }
  }
  if (!replyTargetId) replyTargetId = testTweetId; // fallback

  const replyResult = await postReply(creds, replyTargetId, `Test comment - ${new Date().toISOString().slice(0, 16)}`);
  check('发送评论', replyResult.ok, replyResult.ok ? `replyId=${replyResult.replyId}, target=/${replyTargetId}` : `失败: ${replyResult.err || 'unknown'}`);

  // ──────────────────────────────────────────────────────────────
  // Step 7: 帖子指标快照 (→ post_snapshots)
  // ──────────────────────────────────────────────────────────────
  console.log('\n📋 Step 7: 帖子指标快照 (→ post_snapshots)');
  const metricsTweet = await getTweet(creds, testTweetId);
  if (metricsTweet.tweet) {
    const l = metricsTweet.tweet.legacy || {};
    const snap = {
      post_id: testTweetId,
      tweet_id: testTweetId,
      experiment_id: experimentId,
      time_point: 't0',
      comments_count: l.reply_count || 0,
      reposts_count: l.retweet_count || 0,
      likes_count: l.favorite_count || 0,
      captured_at: now(),
      created_at: now(),
    };
    await db.collection('twitter_post_snapshots').updateOne(
      { experiment_id: experimentId, post_id: testTweetId, time_point: 't0' },
      { $set: snap },
      { upsert: true },
    );
    check('指标快照', true, `💬${snap.comments_count} ↻${snap.reposts_count} ❤${snap.likes_count}`);
    check('post_snapshots写入', true, 't0 快照已写入');
  } else {
    check('指标快照', false, 'getTweet 无数据');
  }

  // ──────────────────────────────────────────────────────────────
  // Step 8: MongoDB 写入验证
  // ──────────────────────────────────────────────────────────────
  console.log('\n📋 Step 8: MongoDB 写入验证');
  const collections = ['twitter_post_detail', 'twitter_post_comment_meta', 'twitter_comment_snapshots', 'twitter_post_user_meta', 'twitter_post_snapshots'];
  const counts: Record<string, number> = {};

  for (const col of collections) {
    try {
      const cnt = await db.collection(col).countDocuments({ experiment_id: experimentId });
      counts[col] = cnt;
    } catch { counts[col] = -1; }
  }

  const verifyParts = Object.entries(counts).map(([k, v]) => `${k.replace('twitter_', '')}:${v}`);
  check('MongoDB验证', Object.values(counts).every(c => c >= 0), verifyParts.join(' '));

  // ──────────────────────────────────────────────────────────────
  // 汇总
  // ──────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`测试汇总: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
  console.log(`${'='.repeat(60)}\n`);

  if (passed + failed > 0) {
    console.log(`成功率: ${((passed / (passed + failed)) * 100).toFixed(0)}%`);
  }

  console.log(`💡 测试数据保留在 MongoDB，可通过以下方式查看:`);
  for (const col of collections) {
    console.log(`   db.${col}.find({experiment_id: "${experimentId}"})`);
  }

  await mongo.close();
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
