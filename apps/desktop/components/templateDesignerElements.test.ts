// @vitest-environment jsdom

import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ElementType } from '../../../packages/desktop-designer/src/types';
import { useDesignerKeyboard } from '../../../packages/desktop-designer/src/hooks/useDesignerKeyboard';
import { addElement } from '../../../packages/desktop-designer/src/utils/elements';

describe('template designer element insertion', () => {
  it('does not stack consecutive elements on the same canvas position', () => {
    const first = addElement([], ElementType.TEXT, { x: 480, y: 459 });
    const second = addElement(first.elements, ElementType.BOX, { x: 480, y: 459 });

    expect([second.elements[1].x, second.elements[1].y]).not.toEqual([
      first.elements[0].x,
      first.elements[0].y,
    ]);
  });
});

describe('template designer inline editing', () => {
  it('exits text editing with Escape', () => {
    const onEscape = vi.fn();
    const noop = vi.fn();
    const { unmount } = renderHook(() =>
      useDesignerKeyboard({
        enabled: false,
        onNudge: noop,
        onDelete: noop,
        onDuplicate: noop,
        onCopy: noop,
        onPaste: noop,
        onUndo: noop,
        onRedo: noop,
        onSelectAll: noop,
        onEscape,
        onSave: noop,
        onBypassSnapChange: noop,
      }),
    );
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.append(editable);

    fireEvent.keyDown(editable, { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledOnce();
    editable.remove();
    unmount();
  });
});
