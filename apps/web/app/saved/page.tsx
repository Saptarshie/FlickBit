import { Screen } from '../../src/components/AppNav';
import SavedScreen from '../../src/components/SavedScreen';

export const metadata = { title: 'Saved — PlayLoop' };

export default function SavedPage() {
  return (
    <Screen title="Saved games">
      <SavedScreen />
    </Screen>
  );
}
