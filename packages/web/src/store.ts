import { configureStore } from '@reduxjs/toolkit';

import { sleuthApi } from '@/api';

export const sleuthStore = configureStore({
  reducer: {
    [sleuthApi.reducerPath]: sleuthApi.reducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(sleuthApi.middleware),
});

export type RootState = ReturnType<typeof sleuthStore.getState>;
export type AppDispatch = typeof sleuthStore.dispatch;
