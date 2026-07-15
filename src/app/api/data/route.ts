import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { query, maybeOne, upsert } from '@/lib/db';

interface PostRow { id: string; post_id: string; post_group: string; }
interface Snapshot { comments: number; reposts: number; likes: number; }

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const { searchParams } = new URL(request.url);
    const experimentId = searchParams.get('experimentId');
    const type = searchParams.get('type') || 'snapshots';
    if (!experimentId) return NextResponse.json({ error: 'Missing experiment ID' }, { status: 400 });

    switch (type) {
      case 'snapshots': {
        const { rows: posts } = await query<PostRow>(
          'posts',
          { experiment_id: experimentId, user_id: auth.id },
        );
        if (!posts.length) return NextResponse.json({ snapshots: [], posts: [] });
        const { rows: snapshots } = await query(
          'post_snapshots',
          { post_id: { $in: posts.map(p => p.id) } },
          { sort: { captured_at: 1 } },
        );
        return NextResponse.json({ posts, snapshots });
      }
      case 'interventions': {
        const { rows: logs } = await query(
          'intervention_logs',
          { experiment_id: experimentId },
        );
        return NextResponse.json({ logs });
      }
      case 'outcome': {
        const { rows: outcome } = await query(
          'outcome_analysis',
          { experiment_id: experimentId },
        );
        return NextResponse.json({ outcome });
      }
      case 'comments': {
        const { rows: posts } = await query(
          'posts',
          { experiment_id: experimentId, user_id: auth.id },
        );
        if (!posts.length) return NextResponse.json({ comments: [] });
        const { rows: comments } = await query(
          'comment_snapshots',
          { post_id: { $in: posts.map(p => p.id) } },
          { sort: { comment_time: -1 } },
        );
        return NextResponse.json({ comments });
      }
      case 'comment_meta': {
        const { rows: meta } = await query(
          'post_comment_meta',
          { experiment_id: experimentId },
        );
        return NextResponse.json({ meta });
      }
      case 'user_meta': {
        const { rows: meta } = await query(
          'post_user_meta',
          { experiment_id: experimentId },
        );
        return NextResponse.json({ meta });
      }
      default:
        return NextResponse.json({ error: 'Unknown data type' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: `Data query failed: ${err}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'calculate_outcome') {
      const { experimentId } = body;
      if (!experimentId) return NextResponse.json({ error: 'Missing experiment ID' }, { status: 400 });

      const { rows: posts } = await query<PostRow>(
        'posts',
        { experiment_id: experimentId, user_id: auth.id },
      );
      let calculated = 0;
      for (const post of posts) {
        const t0 = await maybeOne<Snapshot>(
          'post_snapshots',
          { post_id: post.id, time_point: 't0' },
        ) || { comments: 0, reposts: 0, likes: 0 };
        const t72 = await maybeOne<Snapshot>(
          'post_snapshots',
          { post_id: post.id, time_point: 't72h' },
        ) || { comments: 0, reposts: 0, likes: 0 };

        await upsert(
          'outcome_analysis',
          { experiment_id: experimentId, post_id: post.id },
          {
            post_group: post.post_group,
            baseline_comments: t0.comments, baseline_reposts: t0.reposts, baseline_likes: t0.likes,
            final_comments: t72.comments, final_reposts: t72.reposts, final_likes: t72.likes,
            delta_comments: t72.comments - t0.comments, delta_reposts: t72.reposts - t0.reposts, delta_likes: t72.likes - t0.likes,
            calculated_at: new Date().toISOString(),
          },
        );
        calculated++;
      }
      return NextResponse.json({ success: true, calculatedPosts: calculated });
    }

    if (action === 'collect_comments') {
      const { experimentId } = body;
      if (!experimentId) return NextResponse.json({ error: 'Missing experiment ID' }, { status: 400 });
      // 异步触发评论数据采集（后台运行，不阻塞响应）
      import('@/jobs/analyzer').then(({ runAnalyzer }) => runAnalyzer(experimentId))
        .catch((e) => console.error('评论采集后台任务异常:', e));
      return NextResponse.json({ success: true, message: '评论数据采集任务已触发' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: `Request failed: ${err}` }, { status: 500 });
  }
}
