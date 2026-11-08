import { Screen } from '../../../src/components/AppNav';
import ExploreScreen from '../../../src/components/ExploreScreen';

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  const decoded = decodeURIComponent(tag);
  return (
    <Screen title={`#${decoded}`}>
      <ExploreScreen initialTag={decoded} />
    </Screen>
  );
}
