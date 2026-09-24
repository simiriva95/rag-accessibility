import { useId, useRef, type ReactNode } from 'react';

/**
 * A tablist, following the APG pattern: roving tabindex, arrow keys to move
 * between tabs, Home and End to jump. Only the selected tab is in the tab
 * order, so Tab moves past the whole set to the panel rather than through every
 * tab in it.
 *
 * The panel is focusable and labelled by its tab, which is what lets the skip
 * link and the arrow keys land somewhere that announces itself.
 */

export type Tab<Id extends string> = { id: Id; label: string; panel: ReactNode };

export function Tabs<Id extends string>({
  tabs,
  selected,
  onSelect,
  label,
  sticky = false,
}: {
  tabs: Tab<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  label: string;
  /** Pin the tablist under the top of the viewport, for a panel long enough to scroll away from it. */
  sticky?: boolean;
}) {
  const base = useId();
  const refs = useRef(new Map<Id, HTMLButtonElement>());

  const move = (delta: number) => {
    const index = tabs.findIndex((tab) => tab.id === selected);
    const next = tabs[(index + delta + tabs.length) % tabs.length]!;
    onSelect(next.id);
    refs.current.get(next.id)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const jump = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (jump !== undefined) {
      event.preventDefault();
      return move(jump);
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? tabs[0]! : tabs.at(-1)!;
      onSelect(target.id);
      refs.current.get(target.id)?.focus();
    }
  };

  const active = tabs.find((tab) => tab.id === selected) ?? tabs[0]!;

  return (
    <>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={`flex gap-1 overflow-x-auto border-b border-line ${sticky ? 'sticky top-0 z-10 bg-paper/90 backdrop-blur' : ''}`}
      >
        {tabs.map((tab) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element) refs.current.set(tab.id, element);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                isSelected
                  ? 'border-ink'
                  : 'border-transparent text-ink-2 hover:text-ink'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${base}-panel-${active.id}`}
        aria-labelledby={`${base}-tab-${active.id}`}
        tabIndex={0}
      >
        {active.panel}
      </div>
    </>
  );
}
