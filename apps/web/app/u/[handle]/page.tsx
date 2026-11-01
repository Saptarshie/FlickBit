import { ProfileScreen } from '@/components/ProfileScreen';

export const metadata = {
  title: 'Creator — PlayLoop',
  description: 'Creator profile on PlayLoop',
};

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return <ProfileScreen handle={decodeURIComponent(handle)} />;
}
