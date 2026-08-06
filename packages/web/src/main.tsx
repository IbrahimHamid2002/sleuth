import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { Navbar } from '@/components/navbar';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AnalysisPage } from '@/pages/AnalysisPage';
import { DocsPage } from '@/pages/DocsPage';
import { LandingPage } from '@/pages/LandingPage';
import { ResultsPage } from '@/pages/ResultsPage';
import { WebPage } from '@/pages/WebPage';
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
        <TooltipProvider>
          <BrowserRouter>
            <div className="flex min-h-screen flex-col">
              <Navbar />
              <main className="flex-1">
                <Routes>
                  <Route path="/" element={<LandingPage />} />
                  <Route path="/docs" element={<DocsPage />} />
                  <Route path="/web" element={<WebPage />} />
                  <Route path="/analyze/:runId" element={<AnalysisPage />} />
                  <Route path="/results/:runId" element={<ResultsPage />} />
                </Routes>
              </main>
            </div>
          </BrowserRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </Provider>
  </StrictMode>,
);
