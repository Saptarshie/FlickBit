import { NextRequest } from 'next/server';
import { auth } from '../../../auth';
import { getDb } from '@/lib/db';
import { makeAnonId, setAnonCookie, verifyAnonId } from '@/lib/anon';
import { jsonOk, wrap } from '@/lib/api-helpers';
import { fetchFeedPage } from '@playloop/recsys';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return wrap(async () => {
    const session = await auth();
    const cookieAnon = req.cookies.get('pl_anon')?.value;
    let anonId: string | undefined = cookieAnon && verifyAnonId(cookieAnon) ? cookieAnon : undefined;
    let newlyMintedAnon: string | null = null;

    if (!session?.user?.id && !anonId) {
      anonId = makeAnonId();
      newlyMintedAnon = anonId;
    }

    const { searchParams } = new URL(req.url);
    const cursor = searchParams.get('cursor') || undefined;
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : 10;

    const playOrigin =
      process.env.NEXT_PUBLIC_PLAY_ORIGIN || 'http://play.localhost:3001';

    const feedPage = await fetchFeedPage(getDb(), {
      userId: session?.user?.id,
      anonId,
      cursor,
      limit: Number.isFinite(limit) ? limit : 10,
      playOrigin,
    });

    const response = jsonOk(feedPage);
    if (newlyMintedAnon) {
      setAnonCookie(response.headers, newlyMintedAnon);
    }
    return response;
  });
}
