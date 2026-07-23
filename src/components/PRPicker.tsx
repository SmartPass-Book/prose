import type { PRSummary } from "../types";
import { PRList } from "./PRList";

interface PRPickerProps {
  repo: string;
  prs: PRSummary[];
  loading: boolean;
  filter: string;
  onFilterChange: (filter: string) => void;
  onSelectPR: (number: number) => void;
}

export function PRPicker({
  repo,
  prs,
  loading,
  filter,
  onFilterChange,
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
          <input
            className="filter"
            placeholder="Filter PRs"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
          />
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
