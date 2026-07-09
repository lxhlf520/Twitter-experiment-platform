import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { query, insert } from '@/lib/db';
import { screenTweets } from '@/lib/post-screener';
import { searchTweets, getTweet } from '@/lib/twitter-api';
import { getActiveAccounts, getCredentials } from '@/jobs/shared';

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const { searchParams } = new URL(request.url);
    const experimentId = searchParams.get('experimentId');
    const filter: Record<string, unknown> = { user_id: auth.id };
    if (experimentId) filter.experiment_id = experimentId;
    const { rows } = await query('posts', filter, { sort: { created_at: -1 } });
    return NextResponse.json({ posts: rows });
  } catch (err) {
    return NextResponse.json({ error: `Failed to fetch posts: ${err}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { action, experimentId } = body;

    if (action === 'screen') {
      const { keywords, criteria } = body;
      if (!keywords || !Array.isArray(keywords) || keywords.length === 0)
        return NextResponse.json({ error: 'Missing keywords' }, { status: 400 });

      // Get first active account for screening
      const accounts = await getActiveAccounts();
      if (accounts.length === 0)
        return NextResponse.json({ error: 'No active accounts' }, { status: 400 });

      const creds = getCredentials(accounts[0]);

      // Search and screen tweets
      const allTweets: any[] = [];
      const authorMap = new Map<string, any>();

      for (const kw of keywords) {
        try {
          const result = await searchTweets(creds, kw, { maxResults: 100 });
          for (const t of result.tweets) {
            allTweets.push(t);
          }
          for (const user of result.includes?.users || []) {
            authorMap.set(user.rest_id, user);
          }
        } catch {
          // skip
        }
      }

      const { passed, rejected } = await screenTweets(allTweets, authorMap, criteria || {});
      return NextResponse.json({
        success: true, passed, rejected,
        stats: { passedCount: passed.length, rejectedCount: rejected.length },
      });
    }

    if (action === 'save') {
      const { posts } = body;
      if (!experimentId || !posts || !Array.isArray(posts))
        return NextResponse.json({ error: 'Missing experiment ID or posts' }, { status: 400 });

      const saved: string[] = [];
      for (const post of posts) {
        const row = await insert('posts', {
          user_id: auth.id, experiment_id: experimentId,
          post_id: post.postId, post_url: post.postUrl, content: post.content,
          author_uid: post.authorUid, author_name: post.authorName, followers: post.followers,
          comments_count: post.commentsCount, reposts_count: post.repostsCount,
          likes_count: post.likesCount, published_at: post.publishedAt,
        });
        if (row) saved.push(row.id as string);
      }
      return NextResponse.json({ success: true, savedCount: saved.length, ids: saved });
    }

    return NextResponse.json({ error: 'Invalid action: screen / save' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: `Request failed: ${err}` }, { status: 500 });
  }
}
