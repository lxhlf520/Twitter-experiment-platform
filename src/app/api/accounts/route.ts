import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { query, maybeOne, insert, updateOne, deleteMany } from '@/lib/db';

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const { rows } = await query(
      'twitter_accounts',
      { user_id: auth.id },
      { sort: { created_at: -1 } },
    );
    return NextResponse.json({ accounts: rows });
  } catch (err) {
    return NextResponse.json({ error: `Failed to fetch accounts: ${err}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { twitter_handle, auth_token, ct0, nickname, avatar } = body;

    if (!auth_token || !ct0 || !twitter_handle) {
      return NextResponse.json({ error: 'auth_token, ct0, and twitter_handle are required' }, { status: 400 });
    }

    let action = 'created';
    let account: Record<string, unknown> | null = null;

    if (twitter_handle) {
      const existing = await maybeOne(
        'twitter_accounts',
        { user_id: auth.id, twitter_handle },
      );
      if (existing) {
        account = await updateOne(
          'twitter_accounts',
          { id: existing.id },
          {
            auth_token, ct0,
            nickname: nickname || null, avatar: avatar || null,
            updated_at: new Date().toISOString(),
          },
        );
        action = 'updated';
        return NextResponse.json({ success: true, account, action });
      }
    }

    account = await insert('twitter_accounts', {
      user_id: auth.id,
      twitter_handle,
      auth_token,
      ct0,
      nickname: nickname || null,
      avatar: avatar || null,
      status: 'active',
      daily_comment_count: 0,
      max_daily_comments: 100,
    });
    return NextResponse.json({ success: true, account, action });
  } catch (err) {
    return NextResponse.json({ error: `Failed to save account: ${err}` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const { id } = await request.json();
    if (!id) return NextResponse.json({ error: 'Missing account ID' }, { status: 400 });
    await deleteMany('twitter_accounts', { id, user_id: auth.id });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: `Failed to delete account: ${err}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { id, status, auth_token, ct0,
            daily_comment_count, nickname, avatar, can_comment } = body;
    if (!id) return NextResponse.json({ error: 'Missing account ID' }, { status: 400 });

    const sets: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (status !== undefined) sets.status = status;
    if (auth_token !== undefined) sets.auth_token = auth_token;
    if (ct0 !== undefined) sets.ct0 = ct0;
    if (daily_comment_count !== undefined) sets.daily_comment_count = daily_comment_count;
    if (nickname !== undefined) sets.nickname = nickname;
    if (avatar !== undefined) sets.avatar = avatar;
    if (can_comment !== undefined) sets.can_comment = can_comment;

    const account = await updateOne(
      'twitter_accounts',
      { id, user_id: auth.id },
      sets,
    );
    return NextResponse.json({ success: true, account });
  } catch (err) {
    return NextResponse.json({ error: `Failed to update account: ${err}` }, { status: 500 });
  }
}
