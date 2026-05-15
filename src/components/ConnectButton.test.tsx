import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectButton } from './ConnectButton';

describe('ConnectButton', () => {
  it('renders unsupported notice when navigator.hid is absent', () => {
    const originalHid = (navigator as { hid?: unknown }).hid;
    delete (navigator as { hid?: unknown }).hid;

    render(<ConnectButton />);
    expect(screen.getByText(/WebHID is not available/i)).toBeInTheDocument();

    if (originalHid !== undefined) {
      (navigator as { hid?: unknown }).hid = originalHid;
    }
  });
});
