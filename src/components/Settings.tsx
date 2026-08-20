// App settings popover. Settings are declared as data in useReviewSettings and
// rendered here, so adding one is a single entry in that array rather than new
// markup. `kind` discriminates the control.

export interface ToggleSetting {
  kind: "toggle";
  id: string;
  label: string;
  description: string;
  value: boolean;
  onChange: (next: boolean) => void;
}

/// A one-of-several setting, rendered as a select. The voice picker lives here
/// rather than in the player pill, which has no room for a list.
export interface ChoiceSetting {
  kind: "choice";
  id: string;
  label: string;
  description: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}

export type Setting = ToggleSetting | ChoiceSetting;

interface SettingsMenuProps {
  settings: Setting[];
}

export function SettingsMenu({ settings }: SettingsMenuProps) {
  return (
    <div className="settings-menu" role="dialog" aria-label="Settings">
      <div className="settings-title">Settings</div>
      <ul className="settings-list">
        {settings.map((s) =>
          s.kind === "choice" ? (
            <li key={s.id} className="setting-row">
              <div className="setting-main">
                <span className="setting-text">
                  <span className="setting-label">{s.label}</span>
                  <span className="setting-desc">{s.description}</span>
                </span>
              </div>
              <select
                className="setting-select"
                value={s.value}
                aria-label={s.label}
                onChange={(e) => s.onChange(e.target.value)}
              >
                {s.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </li>
          ) : (
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
          ),
        )}
      </ul>
    </div>
  );
}
