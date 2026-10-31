import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { QueryProvider } from '../src/lib/query';

export const metadata: Metadata = { title: 'PlayLoop', description: 'Scroll. Play. Remix.' };
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, maximumScale: 1, viewportFit: 'cover', themeColor: '#0b0b10',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0b0b10', color: '#fff', fontFamily: 'system-ui', overscrollBehavior: 'none' }}>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
