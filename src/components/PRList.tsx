import type { PRSummary } from "../types";

interface PRListProps {
  prs: PRSummary[];
  selectedPRNumber: number | null;
  loading: boolean;
  onSelect: (number: number) => void;
}

export function PRList({ prs, selectedPRNumber, loading, onSelect }: PRListProps) {
  return (
    <ul className="pr-list">
      {prs.map((pr) => (
        <li
          key={pr.number}
          role="menuitem"
          className={selectedPRNumber === pr.number ? "active" : ""}
          onClick={() => onSelect(pr.number)}
        >
          <div className="pr-title">
            #{pr.number} {pr.title}
          </div>
          <div className="pr-sub">
            {pr.headRefName} · {new Date(pr.updatedAt).toLocaleDateString()}
          </div>
        </li>
      ))}
      {!prs.length && !loading && <li className="empty">No PRs</li>}
    </ul>
  );
}
