import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';

import { Navbar } from '@/components/navbar';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/toaster';
import { sleuthStore } from '@/store';

import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Failed to find the root element to mount Sleuth into.');
}

createRoot(rootElement).render(
  <StrictMode>
    <Provider store={sleuthStore}>
      <ThemeProvider defaultTheme="system">
        <Navbar />
        {/* Task 19B-2 wires page content/routing here — this sub-task only ships the Redux/RTK Query data foundation. */}
        <main />
        <Toaster />
      </ThemeProvider>
    </Provider>
  </StrictMode>,
);
