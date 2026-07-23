// App settings popover. Settings are declared as data in App.tsx and rendered
// here, so adding one is a single entry in that array rather than new markup.
// Only boolean toggles exist today; add a discriminated union on `kind` when a
// setting needs a different control.

export interface ToggleSetting {
  id: string;
  label: string;
  description: string;
  value: boolean;
  onChange: (next: boolean) => void;
}

interface SettingsMenuProps {
  settings: ToggleSetting[];
}

export function SettingsMenu({ settings }: SettingsMenuProps) {
  return (
    <div className="settings-menu" role="dialog" aria-label="Settings">
      <div className="settings-title">Settings</div>
      <ul className="settings-list">
        {settings.map((s) => (
          <li key={s.id} className="setting-row">
            <label className="setting-main">
              <input
                type="checkbox"
                className="setting-switch"
                checked={s.value}
                onChange={(e) => s.onChange(e.target.checked)}
              />
              <span className="setting-text">
                <span className="setting-label">{s.label}</span>
                <span className="setting-desc">{s.description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
