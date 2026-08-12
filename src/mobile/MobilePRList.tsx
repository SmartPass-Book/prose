import type { PRSummary } from "../types";
import { relativeTime } from "../lib/reviewFormatting";

interface MobilePRListProps {
  repo: string;
  prs: PRSummary[];
  loading: boolean;
  refreshing: boolean;
  filter: string;
  onFilterChange: (value: string) => void;
  onRefresh: () => void;
  onSelectPR: (number: number) => void;
  onSignOut: () => void;
  currentUser: string | null;
}

/**
 * The index page of the manuscript: which drafts are open for review.
 *
 * Laid out as a contents page rather than an iOS table - the PR number sits
 * in a folio column on the left the way a page number would, and the title
 * carries the reading face. With one or two open PRs a stock list looks
 * broken; a contents page looks deliberate.
 */
export function MobilePRList({
  repo,
  prs,
  loading,
  refreshing,
  filter,
  onFilterChange,
  onRefresh,
  onSelectPR,
  onSignOut,
  currentUser,
}: MobilePRListProps) {
  const [owner, name] = repo.split("/");

  return (
    <div className="flex h-full flex-col bg-paper">
      {/* The inset is added to, not maxed against. `max(1rem, inset)` resolves
          to exactly the 59px inset on this device, which lands the eyebrow
          flush against the bottom of the safe area with no padding of its own
          while every other block on the page has at least 16px of clearance. */}
      <header className="shrink-0 px-6 pb-5 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <div className="flex items-baseline justify-between">
          <span className="label">{owner}</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="label text-accent disabled:opacity-40"
          >
            {refreshing ? "Checking" : "Check"}
          </button>
        </div>
        {/* leading-none, not leading-tight: at 28px the 1.25 line-height adds
            7px of invisible leading that lands asymmetrically above and below
            the title, so identical margins read as different gaps. With the
            line box equal to the type size, these margins are the real
            optical spacing. */}
        <h1 className="mt-2 font-prose text-[1.75rem] leading-none text-ink">
          {name}
        </h1>
        <p className="mt-3 text-sm text-ink-dim">
          {prs.length === 0
            ? "No drafts in review"
            : `${prs.length} draft${prs.length === 1 ? "" : "s"} in review`}
        </p>

        {prs.length > 6 && (
          <input
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Find a draft"
            autoCorrect="off"
            autoCapitalize="none"
            className="mt-4 w-full border-b border-edge bg-transparent pb-2 text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading && prs.length === 0 ? (
          <p className="px-6 py-10 text-sm text-ink-faint">Loading...</p>
        ) : prs.length === 0 ? (
          <p className="px-6 py-10 text-sm leading-relaxed text-ink-dim">
            {filter
              ? "Nothing matches that."
              : "Open a pull request on GitHub and it will show up here."}
          </p>
        ) : (
          <ul className="border-t border-edge">
            {prs.map((pr) => (
              <li key={pr.number}>
                <button
                  type="button"
                  onClick={() => onSelectPR(pr.number)}
                  className="flex w-full items-baseline gap-3 border-b border-edge px-6 py-5 text-left active:bg-accent-soft"
                >
                  {/* Right-aligned in a 28pt column: wide enough for a
                      four-digit PR number, and the number always ends the same
                      12pt from the title it labels instead of drifting left as
                      digits drop. `items-baseline` on the row sits it on the
                      title's baseline, replacing a guessed `mt-1`. */}
                  <span className="folio w-7 shrink-0 text-right text-sm">
                    {pr.number}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-prose text-[1.1875rem] leading-snug text-ink">
                      {pr.title}
                    </span>
                    <span className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-faint">
                      <span className="truncate">{pr.author.login}</span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">
                        {relativeTime(pr.updatedAt)}
                      </span>
                      {pr.isDraft && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="shrink-0">draft</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pinned to the bottom edge. The hairline is what keeps it from reading
          as adrift when the list is short - it makes the row the page's bottom
          edge rather than something sitting in the middle of empty space.
          `max()` is correct on this inset: the 34px is home-indicator
          clearance, which the content only needs to clear. */}
      <footer className="flex shrink-0 items-center justify-between border-t border-edge px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <span className="label truncate">{currentUser ?? "signed in"}</span>
        <button type="button" onClick={onSignOut} className="label text-accent">
          Sign out
        </button>
      </footer>
    </div>
  );
}
