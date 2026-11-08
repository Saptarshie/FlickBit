import { Suspense } from 'react';
import LoginScreen from '../../src/components/LoginScreen';

export const metadata = { title: 'Sign in — PlayLoop' };

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100dvh', background: '#0b0b10' }} />}>
      <LoginScreen />
    </Suspense>
  );
}
