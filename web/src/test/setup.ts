import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { endTestGeneration } from './user-event';

afterEach(() => {
  // From now on, user-event instances of the finished test refuse to act (see setupUser).
  endTestGeneration();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
