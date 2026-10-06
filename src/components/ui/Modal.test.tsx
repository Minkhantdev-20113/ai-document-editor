// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { Modal } from './Modal';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

function render(element: ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

/** Re-renders the mounted tree with new props (what any parent update does). */
function rerender(element: ReactNode): void {
  act(() => root?.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

/**
 * Mirrors every real call site: a stateful page owning a modal that is opened
 * with an inline `onClose` arrow, and a controlled field inside it.
 */
function TypingHost({ tick }: { readonly tick: number }) {
  const [value, setValue] = useState('');
  return (
    <Modal open title="Add key" onClose={() => undefined}>
      <div data-tick={tick}>
        <input
          aria-label="secret"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
    </Modal>
  );
}

function EscHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Add key
      </button>
      <Modal open={open} title="Add key" onClose={() => setOpen(false)}>
        <input aria-label="secret" />
      </Modal>
    </>
  );
}

const host = (tick: number): ReactNode => (
  <I18nProvider>
    <TypingHost tick={tick} />
  </I18nProvider>
);

describe('Modal focus handling', () => {
  it('keeps focus in the field the user is typing into', () => {
    render(host(0));

    const input = document.querySelector<HTMLInputElement>('input[aria-label="secret"]');
    expect(input).toBeTruthy();
    act(() => input?.focus());
    expect(document.activeElement).toBe(input);

    // A parent re-render hands the modal a fresh inline `onClose` every time.
    // The focus trap must not re-run on those renders - it used to, which
    // yanked focus out of the field after every single character.
    rerender(host(1));
    expect(document.activeElement).toBe(input);

    // Real typing round-trip: React's controlled input keeps both the value
    // and the focus across the state update each keystroke triggers.
    act(() => {
      if (!input) return;
      input.value = 'AQ.AFakeKey';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input?.value).toBe('AQ.AFakeKey');
    expect(document.activeElement).toBe(input);

    act(() => {
      if (!input) return;
      input.value = 'AQ.AFakeKeyRN6';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input?.value).toBe('AQ.AFakeKeyRN6');
    expect(document.activeElement).toBe(input);
  });

  it('closes on Escape through the latest onClose and restores focus', () => {
    render(
      <I18nProvider>
        <EscHost />
      </I18nProvider>,
    );

    const opener = document.querySelector<HTMLButtonElement>('[data-testid="opener"]');
    expect(opener).toBeTruthy();
    act(() => opener?.focus());
    act(() => opener?.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).toBeTruthy();

    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
