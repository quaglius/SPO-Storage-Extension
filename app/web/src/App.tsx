import { AppQueryProvider } from './app/query-client.js';
import { AppRouter } from './app/router.js';
import { ThemeProvider } from './app/theme.js';
import { ToastProvider } from './app/toast.js';

export function App() {
  return (
    <ThemeProvider>
      <AppQueryProvider>
        <ToastProvider>
          <AppRouter />
        </ToastProvider>
      </AppQueryProvider>
    </ThemeProvider>
  );
}
