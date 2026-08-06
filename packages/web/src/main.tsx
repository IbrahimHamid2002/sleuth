import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Navbar } from '@/components/navbar';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/toaster';

import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Failed to find the root element to mount Sleuth into.');
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system">
      <Navbar />
      {/* Task 19B wires page content/routing here — this sub-task only ships the design system. */}
      <main />
      <Toaster />
    </ThemeProvider>
  </StrictMode>,
);
