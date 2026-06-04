// Vitest setup, run before each test file.
//
//   * `@testing-library/jest-dom/vitest` registers DOM matchers
//     (toBeInTheDocument, toHaveTextContent, ...).
//   * `fake-indexeddb/auto` polyfills IndexedDB so the install
//     handle-store tests have a working IDB in jsdom.
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
