import type { RefObject } from "react";

interface FindBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  matchCount: number;
  currentIndex: number;
  onQueryChange: (query: string) => void;
  onCurrentIndexChange: (updater: (index: number) => number) => void;
  onClose: () => void;
}

export function FindBar({
  inputRef,
  query,
  matchCount,
  currentIndex,
  onQueryChange,
  onCurrentIndexChange,
  onClose,
}: FindBarProps) {
  const selectPrevious = () => {
    onCurrentIndexChange((index) => {
      if (matchCount === 0) return -1;
      return (index - 1 + matchCount) % matchCount;
    });
  };

  const selectNext = () => {
    onCurrentIndexChange((index) => {
      if (matchCount === 0) return -1;
      return (index + 1) % matchCount;
    });
  };

  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        placeholder="Find in file"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (event.shiftKey) selectPrevious();
          else selectNext();
        }}
      />
      <span className="find-count">
        {query
          ? matchCount === 0
            ? "0/0"
            : `${currentIndex + 1}/${matchCount}`
          : ""}
      </span>
      <button
        className="find-btn"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={matchCount === 0}
        onClick={selectPrevious}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path fill="currentColor" d="M5 3 1 7h8z" />
        </svg>
      </button>
      <button
        className="find-btn"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={selectNext}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path fill="currentColor" d="M5 7 1 3h8z" />
        </svg>
      </button>
      <button
        className="find-btn"
        title="Close (Esc)"
        aria-label="Close search"
        onClick={onClose}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            fill="currentColor"
            d="M2 1 1 2l3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3z"
          />
        </svg>
      </button>
    </div>
  );
}
