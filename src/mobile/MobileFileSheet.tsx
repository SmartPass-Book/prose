import type { PRFile } from "../types";

interface FileWithCount extends PRFile {
  unresolved: number;
}

interface MobileFileSheetProps {
  files: FileWithCount[];
  activeFile: string | null;
  prTitle: string;
  onSelectFile: (path: string) => void;
  onClose: () => void;
}

/**
 * The draft's contents. Ordered by open notes rather than alphabetically -
 * the file with unanswered notes is the one you came back for.
 */
export function MobileFileSheet({
  files,
  activeFile,
  prTitle,
  onSelectFile,
  onClose,
}: MobileFileSheetProps) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close contents"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30"
      />
      <div className="sheet relative max-h-[72%] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-edge bg-panel pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl">
        <div className="sticky top-0 z-10 border-b border-edge bg-panel px-5 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="label">Contents</span>
            <button
              type="button"
              onClick={onClose}
              className="label text-accent"
            >
              Done
            </button>
          </div>
          <p className="mt-1 truncate font-prose text-[1.0625rem] text-ink">
            {prTitle}
          </p>
        </div>

        <ul>
          {files.map((file) => {
            const name = file.path.split("/").pop() ?? file.path;
            const folder = file.path.slice(0, file.path.length - name.length);
            const active = file.path === activeFile;
            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => {
                    onSelectFile(file.path);
                    onClose();
                  }}
                  className={`flex w-full items-baseline gap-3 border-b border-edge px-5 py-4 text-left active:bg-accent-soft ${
                    active ? "bg-accent-soft/50" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.9375rem] text-ink">
                      {name}
                    </span>
                    {folder && (
                      <span className="mt-0.5 block truncate text-xs text-ink-faint">
                        {folder.replace(/\/$/, "")}
                      </span>
                    )}
                  </span>
                  {file.unresolved > 0 && (
                    <span className="folio shrink-0 text-xs text-ink-dim">
                      {file.unresolved}{" "}
                      {file.unresolved === 1 ? "note" : "notes"}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
