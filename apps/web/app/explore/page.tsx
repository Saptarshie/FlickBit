import { Screen } from '../../src/components/AppNav';
import ExploreScreen from '../../src/components/ExploreScreen';

export const metadata = { title: 'Explore — PlayLoop' };

export default function ExplorePage() {
  return (
    <Screen title="Explore">
      <ExploreScreen />
    </Screen>
  );
}
