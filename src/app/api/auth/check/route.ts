import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, createUser, extractToken } from '@/lib/auth';

/**
 * POST /api/auth/check
 * Body: { token?: string } or uses Authorization header
 * Verify token validity, return user info
 */
export async function POST(request: NextRequest) {
  try {
    let token: string | null = null;

    // Prefer token from body
    const body = await request.json().catch(() => ({}));
    if (body.token) {
      token = body.token;
    } else {
      // From Authorization header
      token = extractToken(request);
    }

    if (!token) {
      return NextResponse.json({ valid: false, error: 'No token provided' }, { status: 400 });
    }

    const user = await verifyToken(token);
    if (user) {
      return NextResponse.json({ valid: true, user: { id: user.id, name: user.name } });
    }

    return NextResponse.json({ valid: false, error: 'Invalid token' }, { status: 401 });
  } catch {
    return NextResponse.json({ valid: false, error: 'Request failed' }, { status: 500 });
  }
}

/**
 * PUT /api/auth/check
 * Body: { name: string }
 * Create a new experiment user (generates token)
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const name = body.name?.trim();

    if (!name || name.length < 2) {
      return NextResponse.json({ error: 'Username must be at least 2 characters' }, { status: 400 });
    }

    const user = await createUser(name);
    if (!user) {
      return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      user: { id: user.id, name: user.name, token: user.token },
    });
  } catch {
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
  }
}
