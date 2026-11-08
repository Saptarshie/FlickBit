import { Screen } from '../../src/components/AppNav';
import NotificationsScreen from '../../src/components/NotificationsScreen';

export const metadata = { title: 'Notifications — PlayLoop' };

export default function NotificationsPage() {
  return (
    <Screen title="Notifications">
      <NotificationsScreen />
    </Screen>
  );
}
