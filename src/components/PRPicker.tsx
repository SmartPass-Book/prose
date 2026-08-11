import type { PRSummary } from "../types";
import { PRList } from "./PRList";

interface PRPickerProps {
  repo: string;
  prs: PRSummary[];
  loading: boolean;
  refreshing: boolean;
  filter: string;
  onFilterChange: (filter: string) => void;
  onRefresh: () => void;
  onSelectPR: (number: number) => void;
}

export function PRPicker({
  repo,
  prs,
  loading,
  refreshing,
  filter,
  onFilterChange,
  onRefresh,
  onSelectPR,
}: PRPickerProps) {
  return (
    <div className="pick-pr" data-tauri-drag-region="deep">
      <div className="pick-pr-inner">
        <h1 className="pick-pr-title">Pick a PR to review</h1>
        <p className="pick-pr-sub">
          Choose an open pull request from {repo} to start reading.
        </p>
        <div className="pick-pr-card">
          <div className="pick-pr-toolbar">
            <input
              className="filter"
              placeholder="Filter PRs"
              value={filter}
              onChange={(event) => onFilterChange(event.target.value)}
            />
            <button
              className={`topbar-icon-btn ${refreshing ? "spinning" : ""}`}
              title="Refresh PR list (Cmd+R)"
              aria-label="Refresh PR list"
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
          </div>
          <PRList
            prs={prs}
            selectedPRNumber={null}
            loading={loading}
            onSelect={onSelectPR}
          />
        </div>
      </div>
    </div>
  );
}
