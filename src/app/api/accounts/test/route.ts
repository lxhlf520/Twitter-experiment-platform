import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { maybeOne, updateOne } from '@/lib/db';
import { searchTweets, postReply, deleteTweet, TwitterCredentials } from '@/lib/twitter-api';

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;

  try {
    const { id } = await request.json();
    if (!id) return NextResponse.json({ error: 'Missing account ID' }, { status: 400 });

    // 查询账号
    const account = await maybeOne<{
      id: string; auth_token: string; ct0: string; twitter_handle: string;
    }>('accounts', { id, user_id: auth.id });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const creds: TwitterCredentials = {
      authToken: account.auth_token,
      ct0: account.ct0,
    };

    let searchOk = false;
    let commentOk = false;
    let errorMsg = '';
    let replyId = '';

    // ── Step 1: 搜索验证认证是否有效 ──
    try {
      const r = await searchTweets(creds, 'hello', { maxResults: 1 });
      searchOk = r.tweets.length > 0;
      if (!searchOk) {
        errorMsg = 'Search returned no results (auth token may be expired)';
      }
    } catch (e: any) {
      errorMsg = `Search error: ${e.message || e}`;
    }

    // ── Step 2: 发评论验证 ──
    if (searchOk) {
      try {
        const r2 = await searchTweets(creds, 'test', { maxResults: 3 });
        if (r2.tweets.length > 0) {
          const targetId = r2.tweets[0].rest_id;
          const reply = await postReply(creds, targetId, 'probe ' + Date.now());

          if (reply.ok && reply.replyId) {
            commentOk = true;
            replyId = reply.replyId;
            // 清理测试评论
            await deleteTweet(creds, reply.replyId);
          } else {
            errorMsg = reply.err || 'Comment post failed';
          }
        } else {
          errorMsg = 'No tweets found to reply to';
        }
      } catch (e: any) {
        errorMsg = `Comment error: ${e.message || e}`;
      }
    }

    // ── Step 3: 更新数据库状态 ──
    const newStatus = searchOk ? 'active' : 'expired';
    const updates: Record<string, unknown> = {
      status: newStatus,
      can_comment: commentOk,
      comment_checked_at: new Date().toISOString(),
    };
    if (errorMsg) {
      updates.comment_ban_reason = errorMsg.substring(0, 500);
    } else if (commentOk) {
      updates.comment_ban_reason = null;
    }

    try {
      await updateOne('accounts', { id, user_id: auth.id }, updates);
    } catch {
      // DB 更新失败不影响返回结果
    }

    return NextResponse.json({
      success: true,
      search_ok: searchOk,
      comment_ok: commentOk,
      error: errorMsg || null,
      reply_id: replyId || null,
      new_status: newStatus,
    });
  } catch (err) {
    return NextResponse.json({ error: `Test failed: ${err}` }, { status: 500 });
  }
}
