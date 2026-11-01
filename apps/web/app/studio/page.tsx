import { Suspense } from 'react';
import { StudioScreen } from '@/components/StudioScreen';

export const metadata = {
  title: 'Vibecode Studio — PlayLoop',
  description: 'Create short HTML5 games instantly with AI',
};

export default function StudioPage() {
  return (
    <Suspense fallback={null}>
      <StudioScreen />
    </Suspense>
  );
}
