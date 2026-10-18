import { Kbd } from './Kbd';
import { Sheet } from './Sheet';

/** Every keyboard shortcut in the app, grouped. The shell implements the global ones. */
const SHORTCUTS: Array<{ group: string; items: Array<{ keys: string[]; label: string; then?: boolean }> }> = [
  {
    group: 'General',
    items: [
      { keys: ['?'], label: 'Show keyboard shortcuts' },
      { keys: ['['], label: 'Collapse or expand the sidebar' },
      { keys: ['T'], label: 'Switch light / dark theme (Shift T on Scenes)' },
      { keys: ['Esc'], label: 'Close a sheet or dialog' },
    ],
  },
  {
    group: 'Go to',
    items: [
      { keys: ['G', 'C'], label: 'Catalog', then: true },
      { keys: ['G', 'S'], label: 'Scenes', then: true },
      { keys: ['G', 'P'], label: 'Previews', then: true },
      { keys: ['G', 'W'], label: 'Watch', then: true },
      { keys: ['G', 'A'], label: 'Analytics', then: true },
    ],
  },
  {
    group: 'Scenes',
    items: [
      { keys: ['T'], label: 'Scene / Table view' },
      { keys: ['Space'], label: 'Play or pause' },
      { keys: ['←', '→'], label: 'Previous / next scene (Table: move between cells)' },
      { keys: ['A'], label: 'Add a box' },
      { keys: ['Enter'], label: 'Table: choose a product for the cell' },
      { keys: ['Delete'], label: 'Table: back to the default' },
    ],
  },
  {
    group: 'Watch',
    items: [
      { keys: ['Space'], label: 'Play or pause' },
      { keys: ['←', '→'], label: 'Seek 5 seconds' },
      { keys: ['S'], label: 'Shop this scene (open products)' },
      { keys: ['B'], label: 'Save the product in this scene' },
      { keys: ['O'], label: 'Original / placed' },
      { keys: ['M'], label: 'Mute' },
      { keys: ['F'], label: 'Full screen' },
    ],
  },
];

/** The `?` sheet listing the app's keyboard shortcuts. */
export function ShortcutsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard shortcuts" width={420}>
      <div className="flex flex-col gap-6 px-5 pt-1 pb-6">
        {SHORTCUTS.map((g) => (
          <section key={g.group} aria-label={g.group}>
            <h3 className="pb-2 text-12 font-medium text-text-3">{g.group}</h3>
            <ul className="flex flex-col">
              {g.items.map((s) => (
                <li key={s.label} className="flex h-10 items-center justify-between gap-4 border-b border-border text-14 text-text-2 last:border-b-0">
                  <span>{s.label}</span>
                  <span className="flex items-center gap-1">
                    {s.keys.map((k, i) => (
                      <span key={k} className="flex items-center gap-1">
                        {i > 0 && <span className="text-12 text-text-3">{s.then ? 'then' : ''}</span>}
                        <Kbd>{k}</Kbd>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
