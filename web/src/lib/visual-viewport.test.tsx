import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, SEARCH_SHEET_CLASS } from '@/components/ui/dialog';
import { MultiSelect } from '@/components/ui/multi-select';
import { setupUser } from '@/test/user-event';
import { readViewportInset, revealAboveKeyboard } from './visual-viewport';

/** A controllable stand-in for window.visualViewport (jsdom has none). */
class FakeVisualViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  /** Simulates the on-screen keyboard opening (covering `px`) or closing (0). */
  keyboard(px: number) {
    this.height = 800 - px;
    this.dispatchEvent(new Event('resize'));
  }
}

let vv: FakeVisualViewport;
function stubPhone(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  vv = new FakeVisualViewport();
  vi.stubGlobal('visualViewport', vv);
  vi.stubGlobal('innerHeight', 800);
  // Run animation-frame callbacks at once so updates are synchronous in tests.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('readViewportInset', () => {
  it('reports the height hidden by the keyboard and the visible height', () => {
    expect(readViewportInset()).toEqual({ bottom: 0, height: 800 });
    vv.height = 460;
    expect(readViewportInset()).toEqual({ bottom: 340, height: 460 });
    vv.offsetTop = 40; // the browser panned the page up to show the focused field
    expect(readViewportInset()).toEqual({ bottom: 300, height: 460 });
  });
});

describe('Dialog sheet and the on-screen keyboard', () => {
  function renderSheet() {
    render(
      <Dialog open title="Choose supplier" onClose={() => undefined} size="sm" className={SEARCH_SHEET_CLASS}>
        <input aria-label="Search suppliers" />
      </Dialog>,
    );
    return screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement;
  }

  it('lifts the sheet above the keyboard and limits it to the visible height, then restores it', () => {
    const dialog = renderSheet();
    expect(dialog.dataset.keyboard).toBeUndefined();
    expect(dialog.style.getPropertyValue('--kb-bottom')).toBe('0px');

    act(() => vv.keyboard(340));
    expect(dialog.dataset.keyboard).toBe('open');
    expect(dialog.style.getPropertyValue('--kb-bottom')).toBe('340px');
    expect(dialog.style.getPropertyValue('--vv-height')).toBe('460px');
    // The classes that consume these variables (phone only; desktop keeps md:m-auto / md:h-…).
    expect(dialog.className).toContain('mb-[var(--kb-bottom,0px)]');
    expect(dialog.className).toContain('max-h-[min(92dvh,calc(var(--vv-height,100dvh)-0.5rem))]');
    expect(dialog.className).toContain('max-md:data-[keyboard=open]:h-[calc(var(--vv-height)-0.5rem)]');
    expect(dialog.className).toContain('md:m-auto');

    act(() => vv.keyboard(0));
    expect(dialog.dataset.keyboard).toBeUndefined();
    expect(dialog.style.getPropertyValue('--kb-bottom')).toBe('0px');
  });

  it('follows rotation and browser-bar changes too (viewport scroll / resize)', () => {
    const dialog = renderSheet();
    act(() => {
      vv.height = 300;
      vv.offsetTop = 20;
      vv.dispatchEvent(new Event('scroll'));
    });
    expect(dialog.style.getPropertyValue('--kb-bottom')).toBe('480px');
    expect(dialog.style.getPropertyValue('--vv-height')).toBe('300px');
  });
});

describe('inline category search on a phone', () => {
  const OPTIONS = ['Stock', 'Transport', 'Repairs'].map((name, i) => ({ id: `c${i}`, name, isActive: true }));

  it('scrolls the search field to the top once the keyboard opens, so results show above it', async () => {
    stubPhone(true);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<MultiSelect label="Categories" noun="category" options={OPTIONS} selected={[]} onChange={() => undefined} />);
    const user = setupUser();
    await user.click(screen.getByLabelText('Search or add category'));
    act(() => vv.keyboard(340));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByLabelText('Search or add category').closest('[data-search-field]'));
  });

  it('does nothing on desktop layouts', () => {
    stubPhone(false);
    const el = document.createElement('div');
    el.scrollIntoView = vi.fn();
    document.body.append(el);
    revealAboveKeyboard(el);
    vv.keyboard(340);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    el.remove();
  });

  it('reveals after a short delay when the keyboard was already open', () => {
    vi.useFakeTimers();
    stubPhone(true);
    const el = document.createElement('div');
    el.scrollIntoView = vi.fn();
    document.body.append(el);
    const stop = revealAboveKeyboard(el);
    vi.advanceTimersByTime(400);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    stop();
    el.remove();
  });
});
