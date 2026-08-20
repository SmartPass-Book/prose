import { openUrl } from "@tauri-apps/plugin-opener";
import type { PR, PRSummary } from "../types";
import { PRList } from "./PRList";
import { relativeTime } from "../lib/reviewFormatting";
import { SettingsMenu, type Setting } from "./Settings";

interface TopBarProps {
  selectedPR: PR;
  prs: PRSummary[];
  loading: boolean;
  filter: string;
  switcherOpen: boolean;
  refreshing: boolean;
  lastRefreshAt: Date | null;
  settingsOpen: boolean;
  settings: Setting[];
  onFilterChange: (filter: string) => void;
  onSelectPR: (number: number) => void;
  onSwitcherToggle: () => void;
  onRefresh: () => void;
  onSettingsToggle: () => void;
}

export function TopBar({
  selectedPR,
  prs,
  loading,
  filter,
  switcherOpen,
  refreshing,
  lastRefreshAt,
  settingsOpen,
  settings,
  onFilterChange,
  onSelectPR,
  onSwitcherToggle,
  onRefresh,
  onSettingsToggle,
}: TopBarProps) {
  return (
    <header className="topbar" data-tauri-drag-region="deep">
      <div className="pr-switcher-wrap">
        <button
          className="pr-switcher"
          onClick={onSwitcherToggle}
          aria-haspopup="menu"
          aria-expanded={switcherOpen}
        >
          <svg
            className="pr-switcher-icon"
            width="15"
            height="15"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              fillRule="evenodd"
              clipRule="evenodd"
              d="M7.177 3.073L9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zM11 2.5h-1V4h1a1 1 0 0 1 1 1v5.628a2.251 2.251 0 1 0 1.5 0V5A2.5 2.5 0 0 0 11 2.5zm1 10.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM3.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"
            />
          </svg>
          <span className="pr-switcher-label">
            <span className="pr-switcher-num">#{selectedPR.number}</span>
            <span className="pr-switcher-title">{selectedPR.title}</span>
          </span>
          <svg
            className="pr-switcher-chevron"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            <path fill="currentColor" d="M1 3l4 4 4-4z" />
          </svg>
        </button>
        {switcherOpen && (
          <div className="pr-switcher-menu" role="menu">
            <input
              className="filter"
              placeholder="Filter PRs"
              autoFocus
              value={filter}
              onChange={(event) => onFilterChange(event.target.value)}
            />
            <PRList
              prs={prs}
              selectedPRNumber={selectedPR.number}
              loading={loading}
              onSelect={onSelectPR}
            />
          </div>
        )}
      </div>
      <button
        className="topbar-icon-btn"
        title={`Open #${selectedPR.number} on GitHub`}
        aria-label="Open this PR on GitHub"
        onClick={() => void openUrl(selectedPR.url)}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
          />
        </svg>
      </button>
      {lastRefreshAt && (
        <span className="last-refresh" title={lastRefreshAt.toLocaleString()}>
          Updated {relativeTime(lastRefreshAt.toISOString())}
        </span>
      )}
      <button
        className={`topbar-icon-btn ${refreshing ? "spinning" : ""}`}
        title="Refresh this PR (Cmd+R)"
        aria-label="Refresh PR data"
        onClick={onRefresh}
        disabled={refreshing}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 3V1L4.5 4 8 7V5a3 3 0 1 1-3 3H3.5A4.5 4.5 0 1 0 8 3z"
          />
        </svg>
      </button>
      <div className="settings-wrap">
        <button
          className={`topbar-icon-btn ${settingsOpen ? "active" : ""}`}
          title="Settings"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={onSettingsToggle}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              fillRule="evenodd"
              clipRule="evenodd"
              d="M8 0a1 1 0 0 0-1 1v.6a6.4 6.4 0 0 0-1.4.58l-.42-.42a1 1 0 0 0-1.42 0l-.76.76a1 1 0 0 0 0 1.42l.42.42A6.4 6.4 0 0 0 2.6 7H2a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h.6c.13.5.33.96.58 1.4l-.42.42a1 1 0 0 0 0 1.42l.76.76a1 1 0 0 0 1.42 0l.42-.42c.44.25.9.45 1.4.58V15a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-.6a6.4 6.4 0 0 0 1.4-.58l.42.42a1 1 0 0 0 1.42 0l.76-.76a1 1 0 0 0 0-1.42l-.42-.42c.25-.44.45-.9.58-1.4H15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-.6a6.4 6.4 0 0 0-.58-1.4l.42-.42a1 1 0 0 0 0-1.42l-.76-.76a1 1 0 0 0-1.42 0l-.42.42A6.4 6.4 0 0 0 10 1.6V1a1 1 0 0 0-1-1H8zm.5 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"
            />
          </svg>
        </button>
        {settingsOpen && <SettingsMenu settings={settings} />}
      </div>
    </header>
  );
}
