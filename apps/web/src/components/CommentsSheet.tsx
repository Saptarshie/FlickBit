'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, RequestError } from '../lib/client-api';

type CommentJson = {
  id: string;
  body: string;
  likeCount: number;
  createdAt: string;
  user: { id: string; handle: string | null; avatarUrl: string | null };
  replies: CommentJson[];
};

type Props = {
  gameId: string;
  open: boolean;
  onClose: () => void;
  onCountChange?: (count: number) => void;
};

/** Bottom sheet with the comment thread for one game. */
export default function CommentsSheet({ gameId, open, onClose, onCountChange }: Props) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['comments', gameId],
    queryFn: () => api.get<{ comments: CommentJson[] }>(`/api/games/${gameId}/comments`),
    enabled: open,
  });

  const comments = data?.comments ?? [];
  const total = comments.reduce((n, c) => n + 1 + c.replies.length, 0);

  useEffect(() => {
    if (open) onCountChange?.(total);
  }, [open, total, onCountChange]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 250);
  }, [open]);

  const post = useMutation({
    mutationFn: (body: string) => api.post(`/api/games/${gameId}/comments`, { body }),
    onSuccess: () => {
      setDraft('');
      setNeedsAuth(false);
      queryClient.invalidateQueries({ queryKey: ['comments', gameId] });
    },
    onError: (err) => {
      if (err instanceof RequestError && err.status === 401) setNeedsAuth(true);
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || post.isPending) return;
    post.mutate(body);
  };

  return (
    <div
      aria-hidden={!open}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          opacity: open ? 1 : 0,
          transition: 'opacity 180ms ease',
        }}
      />
      <div
        role="dialog"
        aria-label="Comments"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '68dvh',
          maxHeight: '68dvh',
          background: '#12121a',
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 220ms cubic-bezier(0.22,0.61,0.36,1)',
          display: 'flex',
          flexDirection: 'column',
          color: '#fff',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{total} comments</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close comments"
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', fontSize: 22, lineHeight: '22px', cursor: 'pointer' }}
          >
            ×
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', WebkitOverflowScrolling: 'touch' }}>
          {isLoading ? <div style={{ opacity: 0.6, fontSize: 14 }}>Loading…</div> : null}
          {isError ? (
            <button type="button" onClick={() => refetch()} style={{ background: 'none', border: 'none', color: '#8ab4ff', fontSize: 14, padding: 0, cursor: 'pointer' }}>
              Could not load comments — retry
            </button>
          ) : null}
          {!isLoading && !isError && comments.length === 0 ? (
            <div style={{ opacity: 0.6, fontSize: 14 }}>No comments yet. Be the first to hype this game.</div>
          ) : null}

          {comments.map((comment) => (
            <div key={comment.id} style={{ padding: '8px 0', display: 'flex', gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 13,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {(comment.user.handle ?? '?').slice(0, 1).toUpperCase()}
              </div>
              <div style={{ minWidth: 0 }}>
                <Link href={`/u/${comment.user.handle ?? ''}`} style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, textDecoration: 'none' }}>
                  @{comment.user.handle ?? 'creator'}
                </Link>
                <div style={{ fontSize: 14, lineHeight: '20px', wordBreak: 'break-word' }}>{comment.body}</div>
                {comment.replies.map((reply) => (
                  <div key={reply.id} style={{ marginTop: 8, paddingLeft: 10, borderLeft: '2px solid rgba(255,255,255,0.10)' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>@{reply.user.handle ?? 'creator'} </span>
                    <span style={{ fontSize: 13 }}>{reply.body}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={submit} style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
            placeholder={needsAuth ? 'Sign in to comment' : 'Add a comment…'}
            aria-label="Add a comment"
            style={{
              flex: 1,
              minHeight: 44,
              borderRadius: 22,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.06)',
              color: '#fff',
              fontSize: 15,
              padding: '0 14px',
              outline: 'none',
            }}
          />
          {needsAuth ? (
            <Link
              href="/login?next=/"
              style={{
                minHeight: 44,
                padding: '0 16px',
                borderRadius: 22,
                background: 'linear-gradient(135deg,#7b5cff,#ff3b8d)',
                color: '#fff',
                textDecoration: 'none',
                display: 'grid',
                placeItems: 'center',
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              Sign in
            </Link>
          ) : (
            <button
              type="submit"
              disabled={post.isPending || draft.trim().length === 0}
              style={{
                minHeight: 44,
                minWidth: 64,
                borderRadius: 22,
                border: 'none',
                background: draft.trim() ? 'linear-gradient(135deg,#7b5cff,#ff3b8d)' : 'rgba(255,255,255,0.14)',
                color: '#fff',
                fontSize: 14,
                fontWeight: 700,
                cursor: draft.trim() ? 'pointer' : 'default',
              }}
            >
              {post.isPending ? '…' : 'Post'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
