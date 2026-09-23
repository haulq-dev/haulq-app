/**
 * The first tab. Office roles get the org's loads (`Loads.tsx`); a driver
 * gets only their own assigned loads (`MyLoads.tsx`). Split here rather than
 * inside either screen, because they are different screens for different
 * jobs that happen to share a URL.
 */

import { useSession } from '../components/AuthGate.tsx';
import { showsTabBar } from '../components/Shell.tsx';
import { LoadsScreen } from './Loads.tsx';
import { MyLoadsScreen } from './MyLoads.tsx';

export function HomeRoute() {
  return showsTabBar(useSession()?.role) ? <LoadsScreen /> : <MyLoadsScreen />;
}
