import { shouldRetryQuery } from '@mastra/playground-ui/utils/query-utils';
import type { QueryClientConfig } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export interface PlaygroundQueryClientProps {
  children: React.ReactNode;
  options?: QueryClientConfig;
}

export const PlaygroundQueryClient = ({ children, options }: PlaygroundQueryClientProps) => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        ...options,
        defaultOptions: {
          ...options?.defaultOptions,
          queries: {
            retry: shouldRetryQuery,
            ...options?.defaultOptions?.queries,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
};

// Intentional React Query compatibility barrel; preserve its public exports.
/* oxlint-disable react/only-export-components */
// eslint-disable-next-line react-refresh/only-export-components -- This compatibility barrel is not a Fast Refresh boundary.
export * from '@tanstack/react-query';
/* oxlint-enable react/only-export-components */
